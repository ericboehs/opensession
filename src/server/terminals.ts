/**
 * Interactive shell terminals for the session viewer's Shell tab.
 *
 * One real PTY per WebSocket client (Bun's native `terminal` spawn option),
 * running the login shell in the session's worktree. Output streams to the
 * client as base64 `term_data` frames; input/resize come back the same way.
 * The PTY dies with its socket (or on term_stop), so nothing leaks past a
 * disconnect — and the map lives on globalThis so a hot reload doesn't orphan
 * running shells.
 *
 * Trust model: the web UI is Tailscale- + team-gated and interactive users are
 * already admin-equivalent (sessions run arbitrary Bash via prompts), so a
 * shell adds convenience, not a new privilege tier.
 */

interface TermEntry {
  proc: ReturnType<typeof Bun.spawn>;
}

const g = globalThis as any;
const terms: Map<unknown, TermEntry> = (g.__backstageTerminals ??= new Map());

export function startTerminal(
  ws: unknown,
  opts: {
    cwd: string;
    cols?: number;
    rows?: number;
    send: (msg: object) => void;
  },
): void {
  stopTerminal(ws); // one shell per socket
  const shell = process.env.SHELL || "/bin/zsh";
  const proc = Bun.spawn([shell, "-il"], {
    cwd: opts.cwd,
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
    if (terms.get(ws)?.proc === proc) {
      terms.delete(ws);
      opts.send({ type: "term_exit", code });
    }
  });

  terms.set(ws, { proc });
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
  const t = terms.get(ws);
  if (!t) return;
  terms.delete(ws);
  try {
    t.proc.kill();
  } catch {}
}
