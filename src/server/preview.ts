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
import { closeSync, existsSync, openSync, readFileSync, readlinkSync, unlinkSync } from "fs";
import { basename, join } from "path";
import { sandboxConfig } from "./sandbox/config";
import type { Sandbox } from "./sandbox/provider";

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
  __previewStartPgids?: Map<string, number>;
};
const starting: Map<string, number> = (gStart.__previewStarting ??= new Map());
// worktreeDir -> process group of the in-flight bring-up (see startPreview's
// setsid). Lets stopPreview cancel a start whose services aren't listening yet.
const startPgids: Map<string, number> = (gStart.__previewStartPgids ??= new Map());
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

/** Parse .ports.conf text into ordered {key, port} entries. */
function parsePortsText(text: string): { key: string; port: number }[] {
  const out: { key: string; port: number }[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+_PORT)\s*=\s*(\d+)\s*$/);
    if (m) out.push({ key: m[1], port: parseInt(m[2], 10) });
  }
  return out;
}

/** Parse `<worktree>/.ports.conf` into ordered {key, port} entries. */
function readPorts(worktreeDir: string): { key: string; port: number }[] {
  const file = join(worktreeDir, ".ports.conf");
  if (!existsSync(file)) return [];
  return parsePortsText(readFileSync(file, "utf8"));
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
 * Screenshot the running preview with headless Chrome (PNG bytes). The preview
 * origin is Caddy's tailnet cert, but Chrome runs before trust is guaranteed —
 * hence --ignore-certificate-errors; --virtual-time-budget lets the SPA settle
 * before the shot, and the whole thing is bounded by `timeout` so a wedged
 * renderer can't hold the request open.
 */
export async function capturePreviewScreenshot(
  worktreeDir: string,
  opts?: { width?: number; height?: number; status?: PreviewStatus },
): Promise<Buffer> {
  // Sandboxed sessions pass their own status (getSandboxPreviewStatus) — the
  // host status below can't see in-container listeners.
  const status = opts?.status ?? (await getPreviewStatus(worktreeDir));
  if (!status.running || !status.previewUrl) {
    throw new Error("Preview isn't running — start it first");
  }
  const out = `/tmp/backstage-preview-shot-${process.pid}-${Date.now()}.png`;
  const w = opts?.width || 1440;
  const h = opts?.height || 900;
  try {
    await $`timeout 45 google-chrome --headless=new --disable-gpu --no-sandbox --hide-scrollbars --ignore-certificate-errors --window-size=${w},${h} --virtual-time-budget=12000 --screenshot=${out} ${status.previewUrl}`.quiet();
    const buf = Buffer.from(await Bun.file(out).arrayBuffer());
    if (!buf.length) throw new Error("Screenshot came back empty");
    return buf;
  } finally {
    try {
      unlinkSync(out);
    } catch {}
  }
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
    // setsid puts the bring-up in its own process group (pgid = pid): the
    // nohup'd `just dev` and everything under it inherit that group, so a
    // cancel (stopPreview mid-start) can kill the whole tree with one signal —
    // and can never hit backstage's own group.
    const proc = Bun.spawn(["setsid", "bash", ENSURE_UP, worktreeDir], {
      stdout: log,
      stderr: log,
      stdin: "ignore",
    });
    startPgids.set(worktreeDir, proc.pid);
    // Don't hold the event loop open on it, and clear the flag when it exits
    // (success flips to running via polling; failure/exit stops "starting").
    proc.unref();
    proc.exited.then(() => {
      starting.delete(worktreeDir);
      startPgids.delete(worktreeDir);
      try {
        closeSync(log);
      } catch {}
    });
  } catch {
    starting.delete(worktreeDir);
    startPgids.delete(worktreeDir);
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
  // An in-flight bring-up has nothing listening yet, so the port scan below
  // can't see it — kill its dedicated process group (set up via setsid in
  // startPreview) so cancelling mid-start actually stops the build/dev server.
  const startPgid = startPgids.get(worktreeDir);
  if (startPgid && startPgid > 1) pgids.add(startPgid);
  // Also pick up any PGID written to disk by ensure-up.sh — covers the agent-
  // invoked path (where startPgids has no entry) and restarted backstage
  // (in-memory map is empty after restart).
  const pgidFile = join(worktreeDir, ".ports", "dev-pgid");
  if (existsSync(pgidFile)) {
    try {
      const pgid = parseInt(readFileSync(pgidFile, "utf8").trim(), 10);
      if (!isNaN(pgid) && pgid > 1) pgids.add(pgid);
    } catch {}
  }
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
  try { unlinkSync(join(worktreeDir, ".ports", "dev-pgid")); } catch {}

  return getPreviewStatus(worktreeDir);
}

// ── Sandboxed previews (docs/sandboxes-plan.md Phase 2) ───────────────────────
// A sandboxed session's dev server runs INSIDE its container, so the host-side
// mechanics above can't see it: `ss` can't observe container listeners, and
// signaling host process groups can't stop them. These variants keep the same
// PreviewStatus shape and reuse the identical Caddy plumbing — the only change
// is the upstream: instead of dialing the dev port directly, Caddy dials the
// container port's PUBLISHED loopback host port (docker -p at container
// create, config `previewPorts`; see docker.ts). A port that isn't published
// stays previewUrl-less — add it to previewPorts and let the container be
// recreated. Callers route here only when the session's sandbox container is
// actually running (the same active check as workspace-exec).

/** True when a TCP connect to 127.0.0.1:<port> succeeds INSIDE the sandbox. */
async function sandboxPortListening(sandbox: Sandbox, port: number): Promise<boolean> {
  const r = await sandbox.exec([
    "timeout", "2", "bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`,
  ]);
  return r.exitCode === 0;
}

export async function getSandboxPreviewStatus(
  sandbox: Sandbox,
  worktreeDir: string,
): Promise<PreviewStatus> {
  // .ports.conf via the sandbox exec — works for bind mounts and is the only
  // way for volume-mode workspaces (no host copy).
  const conf = await sandbox.exec(["cat", ".ports.conf"]);
  const ports = conf.exitCode === 0 ? parsePortsText(conf.stdout) : [];
  const services: PreviewService[] = [];
  for (const { key, port } of ports) {
    const running = await sandboxPortListening(sandbox, port);
    // PIDs are container-internal — meaningless to the host UI; leave empty.
    services.push({ name: friendly(key), key, port, running, pids: [] });
  }
  const webapp = services.find((s) => s.key === "WEBAPP_PORT");

  let previewUrl: string | null = null;
  if (webapp?.running) {
    const published = (await sandbox.ports())[webapp.port];
    if (published) {
      // Same Caddy route as host previews; the https port is keyed by the
      // CONTAINER port (stable across restarts), the upstream dials the
      // published loopback port (may change when the container is recreated —
      // ensurePreviewRoute re-points an existing route on mismatch).
      const httpsPort = httpsPortFor(webapp.port);
      const host = await previewHost();
      if (await ensurePreviewRoute(httpsPort, published, host)) {
        previewUrl = `https://${host}:${httpsPort}`;
      }
    } else {
      console.warn(
        `[preview] ${sandbox.id}: webapp on ${webapp.port} is up in-container but the port isn't published — add it to sandbox previewPorts`,
      );
    }
  } else if (webapp) {
    await removePreviewRoute(httpsPortFor(webapp.port));
  }

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
 * Bring the dev server up INSIDE the sandbox. Gated behind config
 * `devServerInSandbox` (default off): the bring-up script and the repo's dev
 * toolchain must exist in the container for this to work — until the image
 * carries them, only the status/port/Caddy layer above is active and this is
 * a no-op that returns current status.
 */
export async function startSandboxPreview(
  sandbox: Sandbox,
  worktreeDir: string,
): Promise<PreviewStatus> {
  const status = await getSandboxPreviewStatus(sandbox, worktreeDir);
  if (status.running || status.starting) return status;
  if (!sandboxConfig().devServerInSandbox) {
    console.log(
      `[preview] ${sandbox.id}: in-sandbox dev-server start is gated off (devServerInSandbox) — not starting`,
    );
    return status;
  }
  const probe = await sandbox.exec(["test", "-r", ENSURE_UP]);
  if (probe.exitCode !== 0) {
    console.warn(`[preview] ${sandbox.id}: ${ENSURE_UP} not present in the sandbox — cannot start`);
    return status;
  }
  starting.set(worktreeDir, Date.now());
  // Detach inside the container; the container is the session's process scope,
  // so there's no host pgid bookkeeping to do.
  const r = await sandbox.exec([
    "sh", "-c",
    `nohup bash ${ENSURE_UP} ${worktreeDir} >> /tmp/backstage-preview.log 2>&1 &`,
  ]);
  if (r.exitCode !== 0) starting.delete(worktreeDir);
  return { ...status, starting: r.exitCode === 0 };
}

/**
 * Stop a sandboxed session's dev server: drop the Caddy route(s) and signal
 * the dev processes in-container. pkill by pattern is safe HERE (unlike on
 * the host, where it was the "kills every session's webapp" trap) because the
 * container only ever hosts this one session's processes.
 */
export async function stopSandboxPreview(
  sandbox: Sandbox,
  worktreeDir: string,
): Promise<PreviewStatus> {
  starting.delete(worktreeDir);
  const conf = await sandbox.exec(["cat", ".ports.conf"]);
  const ports = conf.exitCode === 0 ? parsePortsText(conf.stdout) : [];
  const webapp = ports.find((p) => p.key === "WEBAPP_PORT");
  if (webapp) await removePreviewRoute(httpsPortFor(webapp.port));
  await sandbox.exec(["pkill", "-f", "next dev"]);
  await sandbox.exec(["sh", "-c", "rm -f .ports/dev-pgid"]);
  return getSandboxPreviewStatus(sandbox, worktreeDir);
}
