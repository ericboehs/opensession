/**
 * Local dev-server ("preview") status + control for a session's worktree.
 *
 * A tella-fusion worktree that has run `just dev` (e.g. via the tella-local
 * skill) writes its allocated ports to `<worktree>/.ports.conf`:
 *
 *   WEBAPP_PORT=3300
 *   INSTANT_PORT=5968
 *   ...
 *
 * `next dev` binds 0.0.0.0, but the webapp can't just be opened at
 * `http://<host>:<WEBAPP_PORT>`: it needs a *secure* (HTTPS) origin to be a
 * trusted context (WebCrypto etc.), and Next dev only hydrates over an origin
 * it's been told to trust. So for each running webapp we expose a dedicated
 * HTTPS port on the tailnet host via Caddy (which already holds the ts.net
 * cert), reverse-proxying to the webapp's port. The session's worktree must
 * have been started with `ALLOWED_DEV_ORIGINS=<host>` so Next dev hydrates over
 * that origin (the tella-local ensure-up.sh seeds it). The preview URL is then
 * `https://<host>:<httpsPort>`.
 */
import { $ } from "bun";
import { closeSync, existsSync, openSync, readFileSync, readlinkSync } from "fs";
import { basename, join } from "path";

export interface PreviewService {
  /** Friendly label, e.g. "Webapp". */
  name: string;
  /** Raw .ports.conf key, e.g. "WEBAPP_PORT". */
  key: string;
  port: number;
  running: boolean;
  pids: number[];
}

export interface PreviewStatus {
  hasPortsConf: boolean;
  /** WEBAPP_PORT, or null if the worktree has no .ports.conf yet. */
  webappPort: number | null;
  /** Whether the webapp itself is currently listening. */
  running: boolean;
  /** True while `startPreview` is bringing the dev server up (not yet listening). */
  starting: boolean;
  /** HTTPS preview URL (Caddy-fronted) when the webapp is up, else null. */
  previewUrl: string | null;
  services: PreviewService[];
}

// The tella-local skill's idempotent bring-up script. Overridable for testing.
const ENSURE_UP =
  process.env.TELLA_LOCAL_ENSURE_UP ||
  "/home/ubuntu/.claude/skills/tella-local/ensure-up.sh";

// Worktrees with an in-flight `startPreview` (worktreeDir -> started-at ms).
// Parked on globalThis so it survives --hot reloads. Entries are cleared when
// the webapp comes up, when the bring-up process exits, or after a TTL (so a
// crashed/never-finished start eventually stops reporting "starting").
const gStart = globalThis as unknown as {
  __previewStarting?: Map<string, number>;
};
const starting: Map<string, number> = (gStart.__previewStarting ??= new Map());
const START_TTL_MS = 5 * 60_000;

function isStarting(worktreeDir: string): boolean {
  const t = starting.get(worktreeDir);
  if (t == null) return false;
  if (Date.now() - t > START_TTL_MS) {
    starting.delete(worktreeDir);
    return false;
  }
  return true;
}

const SERVICE_NAMES: Record<string, string> = {
  WEBAPP_PORT: "Webapp",
  INSTANT_PORT: "Instant API",
  WEBAPP_WORKFLOW_PORT: "Workflow",
  WEBAPP_EMAILS_PREVIEW_PORT: "Emails preview",
  TEMPORAL_PORT: "Temporal",
  TEMPORAL_UI_PORT: "Temporal UI",
};

function friendly(key: string): string {
  if (SERVICE_NAMES[key]) return SERVICE_NAMES[key];
  return key
    .replace(/_PORT$/, "")
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Parse `<worktree>/.ports.conf` into ordered {key, port} entries. */
function readPorts(worktreeDir: string): { key: string; port: number }[] {
  const file = join(worktreeDir, ".ports.conf");
  if (!existsSync(file)) return [];
  const out: { key: string; port: number }[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+_PORT)\s*=\s*(\d+)\s*$/);
    if (m) out.push({ key: m[1], port: parseInt(m[2], 10) });
  }
  return out;
}

/**
 * PIDs with a LISTEN socket on a TCP port (empty if nothing is listening).
 * Uses `ss` rather than `lsof` — on this host lsof can't read the socket→pid
 * mapping without root, but `ss -p` can.
 */
async function listenersOnPort(port: number): Promise<number[]> {
  const raw = await $`ss -tlnpH sport = :${port}`.quiet().nothrow().text();
  const pids = new Set<number>();
  for (const m of raw.matchAll(/pid=(\d+)/g)) pids.add(parseInt(m[1], 10));
  return [...pids];
}

async function pgidOf(pid: number): Promise<number | null> {
  const raw = await $`ps -o pgid= -p ${pid}`.quiet().nothrow().text();
  const n = parseInt(raw.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ── HTTPS preview exposure via Caddy ──────────────────────────────────────────
// Caddy (admin API on localhost:2019) already terminates TLS for this machine's
// ts.net hostname. We add one reverse-proxy server per running webapp, on a
// deterministic high port, so each session gets its own secure origin.

const CADDY_ADMIN = "http://localhost:2019";
const g = globalThis as unknown as {
  __previewRoutes?: Map<number, number>;
  __previewHost?: string;
};
// httpsPort -> webappPort we've already configured (survives --hot reloads).
const previewRoutes: Map<number, number> = (g.__previewRoutes ??= new Map());

/** This machine's tailnet hostname (e.g. michael.taila5d766.ts.net). */
async function previewHost(): Promise<string> {
  if (g.__previewHost) return g.__previewHost;
  let host = process.env.PREVIEW_HOST || "";
  if (!host) {
    try {
      const raw = await $`tailscale status --json`.quiet().nothrow().text();
      host = (JSON.parse(raw)?.Self?.DNSName || "").replace(/\.$/, "");
    } catch {}
  }
  if (!host) host = "michael.taila5d766.ts.net";
  g.__previewHost = host;
  return host;
}

// Webapp dev ports are 3100-3999 and globally unique among running servers, so
// +6000 gives a unique, stable preview port in 9100-9999.
function httpsPortFor(webappPort: number): number {
  return webappPort + 6000;
}

/** Add/refresh the Caddy server for this webapp (idempotent, cached). */
async function ensurePreviewRoute(httpsPort: number, webappPort: number, host: string): Promise<boolean> {
  if (previewRoutes.get(httpsPort) === webappPort) return true;
  const server = {
    listen: [`:${httpsPort}`],
    routes: [
      {
        match: [{ host: [host] }],
        handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `127.0.0.1:${webappPort}` }] }],
        terminal: true,
      },
    ],
  };
  const path = `${CADDY_ADMIN}/config/apps/http/servers/preview_${httpsPort}`;
  const put = () =>
    fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(server),
    });
  try {
    // PUT creates the key; if it already exists (e.g. Caddy kept the server
    // across a backstage restart, so our cache is cold) it 409s — drop it and
    // recreate so the route always ends up pointing at the current webapp port.
    let res = await put();
    if (res.status === 409) {
      await fetch(path, { method: "DELETE" }).catch(() => {});
      res = await put();
    }
    if (!res.ok) return false;
    previewRoutes.set(httpsPort, webappPort);
    return true;
  } catch {
    return false;
  }
}

async function removePreviewRoute(httpsPort: number): Promise<void> {
  if (!previewRoutes.has(httpsPort)) return;
  try {
    await fetch(`${CADDY_ADMIN}/config/apps/http/servers/preview_${httpsPort}`, { method: "DELETE" });
  } catch {}
  previewRoutes.delete(httpsPort);
}

export async function getPreviewStatus(worktreeDir: string): Promise<PreviewStatus> {
  const ports = readPorts(worktreeDir);
  const services: PreviewService[] = await Promise.all(
    ports.map(async ({ key, port }) => {
      const pids = await listenersOnPort(port);
      return { name: friendly(key), key, port, running: pids.length > 0, pids };
    }),
  );
  const webapp = services.find((s) => s.key === "WEBAPP_PORT");

  // Keep the Caddy HTTPS exposure in sync with the webapp's state: add the
  // route while it's up (so the preview URL is live and the button opens it
  // directly), drop it once it's gone.
  let previewUrl: string | null = null;
  if (webapp?.running) {
    const httpsPort = httpsPortFor(webapp.port);
    const host = await previewHost();
    if (await ensurePreviewRoute(httpsPort, webapp.port, host)) {
      previewUrl = `https://${host}:${httpsPort}`;
    }
  } else if (webapp) {
    await removePreviewRoute(httpsPortFor(webapp.port));
  }

  // Once the webapp is listening, the bring-up is done — clear any "starting".
  if (webapp?.running) starting.delete(worktreeDir);

  return {
    hasPortsConf: ports.length > 0,
    webappPort: webapp?.port ?? null,
    running: !!webapp?.running,
    starting: !webapp?.running && isStarting(worktreeDir),
    previewUrl,
    services,
  };
}

/**
 * Bring the session's local dev server up (Tella Local) if it isn't already,
 * by running the tella-local `ensure-up.sh` against this worktree. The script
 * is idempotent and self-detaches `just dev` (nohup), but its first-build wait
 * can take minutes — so we spawn it in the background and return immediately
 * with `starting: true`. Callers poll `getPreviewStatus` to see it flip to
 * `running` once the webapp is listening.
 */
export async function startPreview(worktreeDir: string): Promise<PreviewStatus> {
  const status = await getPreviewStatus(worktreeDir);
  if (status.running || status.starting) return status;
  if (!existsSync(ENSURE_UP)) return status; // nothing to run

  starting.set(worktreeDir, Date.now());
  try {
    const log = openSync(
      `/tmp/backstage-preview-${basename(worktreeDir)}.log`,
      "a",
    );
    const proc = Bun.spawn(["bash", ENSURE_UP, worktreeDir], {
      stdout: log,
      stderr: log,
      stdin: "ignore",
    });
    // Don't hold the event loop open on it, and clear the flag when it exits
    // (success flips to running via polling; failure/exit stops "starting").
    proc.unref();
    proc.exited.then(() => {
      starting.delete(worktreeDir);
      try {
        closeSync(log);
      } catch {}
    });
  } catch {
    starting.delete(worktreeDir);
  }
  return { ...status, starting: true };
}

/**
 * Stop the session's dev server. We can't use `just dev-stop` — it `pkill -f
 * "next dev"` globally and would kill every other session's webapp. Instead we
 * find the process group behind this worktree's ports and signal just that
 * group, which also takes down the `while true; do next dev; done` supervisor
 * (so it doesn't respawn) without touching anything outside the worktree.
 *
 * Safety: a PID is only eligible if its cwd is inside `worktreeDir`, so the
 * backstage server (and unrelated worktrees) can never be a target.
 */
export async function stopPreview(worktreeDir: string): Promise<PreviewStatus> {
  starting.delete(worktreeDir); // a stop cancels any in-flight "starting" state
  const ports = readPorts(worktreeDir);
  const pgids = new Set<number>();
  for (const { port } of ports) {
    for (const pid of await listenersOnPort(port)) {
      let cwd = "";
      try {
        cwd = readlinkSync(`/proc/${pid}/cwd`);
      } catch {}
      if (!cwd || !(cwd === worktreeDir || cwd.startsWith(worktreeDir + "/"))) continue;
      const pgid = await pgidOf(pid);
      if (pgid && pgid > 1) pgids.add(pgid);
    }
  }

  for (const pgid of pgids) {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {}
  }
  // Give it a moment to exit cleanly, then SIGKILL whatever's still around.
  await new Promise((r) => setTimeout(r, 1500));
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, 0); // throws if the group is already gone
      process.kill(-pgid, "SIGKILL");
    } catch {}
  }

  return getPreviewStatus(worktreeDir);
}
