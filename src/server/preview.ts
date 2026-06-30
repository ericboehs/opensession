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
 * `next dev` binds 0.0.0.0, so the webapp is reachable across the tailnet at
 * `http://<this-host>:<WEBAPP_PORT>` — the frontend builds that URL from
 * `location.hostname`. Here we only report which services are actually
 * listening (so the UI can enable the Preview button + show running processes)
 * and stop them on request.
 */
import { $ } from "bun";
import { existsSync, readFileSync, readlinkSync } from "fs";
import { join } from "path";

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
  services: PreviewService[];
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

export async function getPreviewStatus(worktreeDir: string): Promise<PreviewStatus> {
  const ports = readPorts(worktreeDir);
  const services: PreviewService[] = await Promise.all(
    ports.map(async ({ key, port }) => {
      const pids = await listenersOnPort(port);
      return { name: friendly(key), key, port, running: pids.length > 0, pids };
    }),
  );
  const webapp = services.find((s) => s.key === "WEBAPP_PORT");
  return {
    hasPortsConf: ports.length > 0,
    webappPort: webapp?.port ?? null,
    running: !!webapp?.running,
    services,
  };
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
