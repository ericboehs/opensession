/**
 * Interactive shell terminals for the session viewer's Shell tab.
 *
 * One real PTY per WebSocket client (Bun's native `terminal` spawn option).
 * Output streams to the client as base64 `term_data` frames; input/resize come
 * back the same way. The PTY dies with its socket (or on term_stop), so
 * nothing leaks past a disconnect — and the map lives on globalThis so a hot
 * reload doesn't orphan running shells.
 *
 * Sandbox-aware (startSessionTerminal): the PTY lands where the session's
 * work actually happens.
 *  - No sandbox (or any failure mode): the login shell in the session's
 *    worktree on the host — exactly the pre-sandbox behavior.
 *  - ACTIVE docker sandbox: `docker exec -it … bash -il` in the session's
 *    container, cwd = the workspace (works for bind AND volume mode — volume
 *    workspaces have no host copy at all). Opening a terminal is an
 *    interactive action, so unlike the read surfaces (workspace-exec) it
 *    WAKES a stopped container (`docker start` first); the idle-stop sweep
 *    still applies, and stopping the container simply ends the shell
 *    (term_exit) — restart-on-demand by reopening the tab.
 *  - Daytona sandbox: a host `ssh` through Daytona's SSH gateway
 *    (`createSshAccess` → `ssh <token>@ssh.app.daytona.io`, proven reachable
 *    from this host 2026-07-08). The token is minted per shell and revoked
 *    when it closes. No ttyd, no published port, no extra HTTPS surface —
 *    the tunnel terminates at backstage and the browser only ever speaks the
 *    existing tailnet-gated session WS.
 *
 * Trust model: the web UI is Tailscale- + team-gated and interactive users are
 * already admin-equivalent (sessions run arbitrary Bash via prompts), so a
 * shell — host or in-sandbox — adds convenience, not a new privilege tier.
 * Nothing here is reachable from automation runs.
 *
 * NOTE: reached only through backstage.ts's WS handlers, which do NOT
 * hot-apply — changes here need a real restart to take effect.
 */

import { existsSync } from "fs";

interface TermEntry {
  proc: ReturnType<typeof Bun.spawn>;
  /** Transport teardown (e.g. revoke the Daytona SSH token). */
  dispose?: () => void;
}

const g = globalThis as any;
const terms: Map<unknown, TermEntry> = (g.__backstageTerminals ??= new Map());
/** In-flight async starts (ws → generation token): a stop or re-start that
 *  lands while a sandbox target is still resolving cancels the stale one. */
const pendingStarts: Map<unknown, object> = (g.__backstageTermPending ??= new Map());

const HOME = process.env.HOME || "/home/ubuntu";

/** The slice of UnifiedSession / the session file the terminal target needs. */
export interface TerminalSessionInfo {
  worktreeDir?: string | null;
  sandbox?: { provider?: string; sandboxId?: string; workspace?: string };
}

export interface TerminalOpts {
  cols?: number;
  rows?: number;
  send: (msg: object) => void;
}

type TermTargetKind = "host" | "docker" | "daytona";

interface TermTarget {
  argv: string[];
  /** Host cwd for the spawned process (undefined for sandbox transports —
   *  their cwd lives inside the sandbox). */
  cwd?: string;
  /** Where the shell actually runs, for the UI's term_ready banner. */
  target: TermTargetKind;
  /** The workspace path the shell lands in (host or in-sandbox). */
  displayCwd: string;
  /** Dim one-liner explaining a fallback (e.g. sandbox unreachable). */
  notice?: string;
  dispose?: () => void;
}

function hostShellTarget(session: TerminalSessionInfo | null | undefined, notice?: string): TermTarget {
  const shell = process.env.SHELL || "/bin/zsh";
  const cwd =
    session?.worktreeDir && existsSync(session.worktreeDir) ? session.worktreeDir : HOME;
  return { argv: [shell, "-il"], cwd, target: "host", displayCwd: cwd, notice };
}

/**
 * Decide where the session's shell runs. Never throws — every failure mode
 * degrades to the host shell with a notice (same fail-open shape as
 * workspace-exec, except a terminal deliberately WAKES a stopped docker
 * container: it's an interactive gesture, not a background read).
 */
async function resolveTarget(
  session: TerminalSessionInfo | null | undefined,
): Promise<TermTarget> {
  const sb = session?.sandbox;
  if (!sb?.sandboxId || !sb.provider || sb.provider === "local") {
    return hostShellTarget(session);
  }
  const cwd = session?.worktreeDir || HOME;
  try {
    const { sandboxesEnabled, sandboxProviderConfigured } = await import("./sandbox/config");
    if (!sandboxesEnabled()) return hostShellTarget(session); // kill-switch

    if (sb.provider === "docker" && sandboxProviderConfigured("docker")) {
      // Wake on demand — `docker start` is a no-op on a running container.
      const start = Bun.spawn(["docker", "start", sb.sandboxId], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [code, err] = await Promise.all([
        start.exited,
        new Response(start.stderr).text(),
      ]);
      if (code !== 0) {
        return hostShellTarget(
          session,
          `sandbox container unavailable (${err.trim().slice(0, 120)}) — opened a host shell instead`,
        );
      }
      const { touchSandboxActivity } = await import("./sandbox/docker");
      touchSandboxActivity(sb.sandboxId);
      return {
        argv: [
          "docker", "exec", "-it",
          "-e", "TERM=xterm-256color",
          "-w", cwd,
          sb.sandboxId,
          "bash", "-il",
        ],
        target: "docker",
        displayCwd: cwd,
      };
    }

    if (sb.provider === "daytona" && sandboxProviderConfigured("daytona")) {
      const { daytonaTerminalAccess } = await import("./sandbox/adapters/daytona");
      const access = await daytonaTerminalAccess(sb.sandboxId, cwd);
      return {
        argv: access.argv,
        target: "daytona",
        displayCwd: cwd,
        dispose: () => void access.revoke(),
      };
    }
  } catch (e: any) {
    return hostShellTarget(
      session,
      `sandbox terminal unavailable (${String(e?.message || e).slice(0, 160)}) — opened a host shell instead`,
    );
  }
  return hostShellTarget(session);
}

/**
 * Session-aware terminal start (the term_start WS handler's entry): resolves
 * the target (host / docker sandbox / daytona sandbox) and spawns the PTY.
 * Async because sandbox resolution can take seconds (container wake, SSH
 * token mint) — a term_stop or another term_start racing in cancels it.
 */
export async function startSessionTerminal(
  ws: unknown,
  session: TerminalSessionInfo | null | undefined,
  opts: TerminalOpts,
): Promise<void> {
  stopTerminal(ws); // one shell per socket
  const token = {};
  pendingStarts.set(ws, token);
  const target = await resolveTarget(session);
  if (pendingStarts.get(ws) !== token) {
    // Stopped or superseded while resolving — release the transport.
    try {
      target.dispose?.();
    } catch {}
    return;
  }
  pendingStarts.delete(ws);
  spawnPty(ws, target, opts);
}

/** Host-only entry with the pre-sandbox signature. Kept so a hot reload of
 *  this module under an older backstage.ts handler keeps working; new code
 *  should use startSessionTerminal. */
export function startTerminal(
  ws: unknown,
  opts: { cwd: string } & TerminalOpts,
): void {
  stopTerminal(ws);
  const shell = process.env.SHELL || "/bin/zsh";
  spawnPty(ws, { argv: [shell, "-il"], cwd: opts.cwd, target: "host", displayCwd: opts.cwd }, opts);
}

function spawnPty(ws: unknown, target: TermTarget, opts: TerminalOpts): void {
  const proc = Bun.spawn(target.argv, {
    cwd: target.cwd,
    env: { ...process.env, TERM: "xterm-256color" },
    terminal: {
      cols: Math.max(20, Math.min(500, opts.cols || 100)),
      rows: Math.max(5, Math.min(200, opts.rows || 30)),
      data: (_term: unknown, chunk: Uint8Array) => {
        opts.send({
          type: "term_data",
          data: Buffer.from(chunk).toString("base64"),
        });
      },
    },
  } as any);

  void proc.exited.then((code) => {
    const t = terms.get(ws);
    if (t?.proc === proc) {
      terms.delete(ws);
      try {
        t.dispose?.();
      } catch {}
      opts.send({ type: "term_exit", code });
    }
  });

  terms.set(ws, { proc, dispose: target.dispose });
  opts.send({ type: "term_ready", target: target.target, cwd: target.displayCwd });
  if (target.notice) opts.send({ type: "term_notice", message: target.notice });
}

export function writeTerminal(ws: unknown, dataB64: string): void {
  const t = terms.get(ws);
  if (!t) return;
  try {
    (t.proc as any).terminal?.write(Buffer.from(dataB64, "base64"));
  } catch {}
}

export function resizeTerminal(ws: unknown, cols: number, rows: number): void {
  const t = terms.get(ws);
  if (!t || !cols || !rows) return;
  try {
    (t.proc as any).terminal?.resize(
      Math.max(20, Math.min(500, Math.round(cols))),
      Math.max(5, Math.min(200, Math.round(rows))),
    );
  } catch {}
}

export function stopTerminal(ws: unknown): void {
  pendingStarts.delete(ws); // cancel an in-flight async start
  const t = terms.get(ws);
  if (!t) return;
  terms.delete(ws);
  try {
    t.proc.kill();
  } catch {}
  try {
    t.dispose?.();
  } catch {}
}
