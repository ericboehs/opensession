const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const HEALTH_ATTEMPTS = 40;
const HEALTH_INTERVAL_MS = 500;
const MAX_RESTART_BACKOFF_MS = 30_000;

function executable(pathname) {
  try {
    fs.accessSync(pathname, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOnPath(name, envPath = process.env.PATH || "") {
  for (const directory of envPath.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    if (executable(candidate)) return candidate;
  }
  return null;
}

function resolveOpencode(resourcesPath, homeDir, envPath) {
  const candidates = [
    path.join(resourcesPath, "opencode"),
    path.join(homeDir, "os1", "bin", "opencode"),
    resolveOnPath("opencode", envPath),
  ];
  return candidates.find((candidate) => candidate && executable(candidate)) || null;
}

function resolveBun(homeDir, envPath) {
  const candidates = [path.join(homeDir, ".bun", "bin", "bun"), resolveOnPath("bun", envPath)];
  return candidates.find((candidate) => candidate && executable(candidate)) || null;
}

function readToken(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed.token === "string" && parsed.token.trim()
      ? parsed.token.trim()
      : null;
  } catch {
    return null;
  }
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => (error || !port ? reject(error || new Error("No free port")) : resolve(port)));
    });
  });
}

class LocalServerSupervisor {
  constructor({ config, resourcesPath, userDataDir, onState }) {
    this.config = config;
    this.resourcesPath = resourcesPath;
    this.userDataDir = userDataDir;
    this.homeDir = os.homedir();
    this.onState = onState;
    this.state = "stopped";
    this.child = null;
    this.generation = 0;
    this.restartTimer = null;
    this.killTimer = null;
    this.stabilityTimer = null;
    this.restartBackoffMs = 1_000;
    this.stopping = false;
    this.prepared = null;
    this.logFile = path.join(userDataDir, "local-server.log");
  }

  async prepare() {
    const defaultServerDir = path.join(this.homeDir, "os1", "server");
    const configuredDir =
      typeof this.config.serverDir === "string" && this.config.serverDir.trim()
        ? this.config.serverDir.trim()
        : null;
    const serverDir = path.resolve(configuredDir || defaultServerDir);
    if (!fs.existsSync(path.join(serverDir, "opensession.ts"))) {
      throw new Error(`OpenSession server source is missing at ${serverDir}`);
    }

    const opencodeBin = resolveOpencode(this.resourcesPath, this.homeDir, process.env.PATH);
    if (!opencodeBin) {
      throw new Error(
        "OpenCode was not found in the app bundle, ~/os1/bin, or PATH",
      );
    }

    const bunBin = resolveBun(this.homeDir, process.env.PATH);
    if (!bunBin) {
      throw new Error("Bun was not found at ~/.bun/bin/bun or on PATH");
    }

    const port = await pickFreePort();
    const configuredToken =
      typeof this.config.cloudToken === "string" && this.config.cloudToken.trim()
        ? this.config.cloudToken.trim()
        : null;
    const cloudToken =
      configuredToken ||
      readToken(path.join(this.homeDir, ".opensession-frontend-dev-token.json"));

    this.prepared = {
      bunBin,
      cloudToken,
      opencodeBin,
      port,
      serverDir,
      url: `http://127.0.0.1:${port}/`,
    };
    return this.prepared;
  }

  start() {
    if (!this.prepared) throw new Error("Local server supervisor was not prepared");
    if (this.child || this.restartTimer || this.stopping) return;
    this.spawnServer();
  }

  setState(state, detail = null) {
    this.state = state;
    this.onState?.({ state, detail, logFile: this.logFile });
  }

  appendLog(message) {
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      fs.appendFileSync(this.logFile, `[shell ${new Date().toISOString()}] ${message}\n`);
    } catch {}
  }

  spawnServer() {
    if (this.stopping) return;
    const generation = ++this.generation;
    const { bunBin, cloudToken, opencodeBin, port, serverDir } = this.prepared;
    const env = {
      ...process.env,
      HOST: "127.0.0.1",
      OPENSESSION_OPENCODE_BIN: opencodeBin,
      OPENSESSION_PROFILE: "local",
      PORT: String(port),
    };
    if (cloudToken) env.OPENSESSION_CLOUD_TOKEN = cloudToken;
    else delete env.OPENSESSION_CLOUD_TOKEN;

    let logFd;
    try {
      fs.mkdirSync(this.userDataDir, { recursive: true });
      logFd = fs.openSync(this.logFile, "a");
      this.appendLog(`starting server on port ${port} from ${serverDir}`);
      this.setState("starting", `Starting local server on port ${port}…`);
      const child = spawn(bunBin, ["run", "opensession.ts"], {
        cwd: serverDir,
        env,
        stdio: ["ignore", logFd, logFd],
      });
      this.child = child;
      fs.closeSync(logFd);
      logFd = null;

      let handled = false;
      const handleExit = (reason) => {
        if (handled) return;
        handled = true;
        if (this.child === child) this.child = null;
        this.appendLog(reason);
        if (!this.stopping && generation === this.generation) this.scheduleRestart(reason);
      };
      child.once("error", (error) => handleExit(`spawn failed: ${error.message}`));
      child.once("exit", (code, signal) =>
        handleExit(`server exited (code=${code ?? "none"}, signal=${signal ?? "none"})`),
      );
      this.waitForHealth(child, generation);
    } catch (error) {
      if (logFd != null) fs.closeSync(logFd);
      this.child = null;
      this.appendLog(`spawn failed: ${error.message}`);
      this.scheduleRestart(error.message);
    }
  }

  async waitForHealth(child, generation) {
    const healthUrl = new URL("api/health", this.prepared.url);
    for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++) {
      if (this.stopping || this.child !== child || generation !== this.generation) return;
      try {
        const response = await fetch(healthUrl, { signal: AbortSignal.timeout(1_500) });
        const body = response.ok ? await response.json() : null;
        if (body?.ok) {
          this.setState("ready");
          this.stabilityTimer = setTimeout(() => {
            if (this.child === child && generation === this.generation) {
              this.restartBackoffMs = 1_000;
            }
          }, 30_000);
          this.stabilityTimer.unref();
          return;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
    }

    if (this.child !== child || generation !== this.generation || this.stopping) return;
    this.appendLog("health check timed out; terminating server");
    child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      if (this.child === child) child.kill("SIGKILL");
    }, 5_000);
    this.killTimer.unref();
  }

  scheduleRestart(reason) {
    if (this.stopping || this.restartTimer) return;
    if (this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    const delay = this.restartBackoffMs;
    this.restartBackoffMs = Math.min(delay * 2, MAX_RESTART_BACKOFF_MS);
    this.setState("backoff", `Local server stopped. Restarting in ${delay / 1_000}s…`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.spawnServer();
    }, delay);
    this.restartTimer.unref();
    this.appendLog(`${reason}; restart scheduled in ${delay}ms`);
  }

  stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.generation++;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.restartTimer = null;
    this.killTimer = null;
    this.stabilityTimer = null;
    this.setState("stopping");
    if (this.child) {
      this.appendLog("app quitting; sending SIGTERM");
      this.child.kill("SIGTERM");
    }
    this.setState("stopped");
  }
}

module.exports = {
  LocalServerSupervisor,
  resolveBun,
  resolveOpencode,
  resolveOnPath,
};
