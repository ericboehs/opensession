import React, { useEffect, useRef, useState } from "react";
import type { TranscriptEntry, WSServerMessage } from "../lib/types";

interface Props {
  entries: TranscriptEntry[];
  /** Session whose worktree the Shell tab opens in. */
  sessionId: string;
  /** WS send/subscribe, for the interactive shell frames. */
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * Terminal panel: two modes.
 * - Commands: read-only live view of every Bash command the agent has run.
 * - Shell: a real interactive terminal (xterm.js over a server-side PTY) in
 *   the session's worktree — poke at the agent's checkout without leaving
 *   the browser. The PTY lives per-WebSocket and dies on disconnect.
 */
export function TerminalPanel({ entries, sessionId, send, addHandler }: Props) {
  const [mode, setMode] = useState<"commands" | "shell">("commands");

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-2 pt-1.5 pb-1 shrink-0">
        <button
          className={`btn-small ${mode === "commands" ? "!bg-active !text-fg" : ""}`}
          onClick={() => setMode("commands")}
        >
          Commands
        </button>
        <button
          className={`btn-small ${mode === "shell" ? "!bg-active !text-fg" : ""}`}
          onClick={() => setMode("shell")}
          title="Interactive shell in this session's worktree"
        >
          Shell
        </button>
      </div>
      {mode === "commands" ? (
        <CommandHistory entries={entries} />
      ) : (
        <ShellView sessionId={sessionId} send={send} addHandler={addHandler} />
      )}
    </div>
  );
}

/** Live terminal view of every Bash command the session has run. */
function CommandHistory({ entries }: { entries: TranscriptEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const toolResults = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.type === "tool_result" && e.toolUseId) toolResults.set(e.toolUseId, e);
  }

  const commands = entries.filter(
    (e) => e.type === "tool_use" && e.toolName === "Bash"
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 300;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [commands.length]);

  if (commands.length === 0) {
    return <div className="panel-placeholder">No commands run yet</div>;
  }

  return (
    <div className="terminal" ref={scrollRef}>
      {commands.map((cmd) => {
        const input = cmd.toolInput as { command?: string; description?: string } | undefined;
        const result = cmd.toolUseId ? toolResults.get(cmd.toolUseId) : undefined;
        return (
          <div key={cmd.id} className="terminal-entry">
            <div className="terminal-cmd">
              <span className="terminal-prompt">$</span> {input?.command || cmd.content}
            </div>
            {result ? (
              result.content.trim() ? (
                <pre className="terminal-output">{truncate(result.content, 4000)}</pre>
              ) : null
            ) : (
              <div className="terminal-running">running…</div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "\n… (truncated)";
}

// ── Interactive shell (xterm.js ↔ server PTY over the session WS) ──

function b64encode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ShellView({
  sessionId,
  send,
  addHandler,
}: {
  sessionId: string;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // Dynamic import keeps xterm out of the initial bundle path.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;

      const cs = getComputedStyle(document.documentElement);
      const term = new Terminal({
        fontSize: 12.5,
        fontFamily:
          cs.getPropertyValue("--mono").trim() ||
          "ui-monospace, SFMono-Regular, Menlo, monospace",
        cursorBlink: true,
        scrollback: 5000,
        theme: {
          background: cs.getPropertyValue("--bg").trim() || "#141414",
          foreground: cs.getPropertyValue("--text").trim() || "#e6e6e6",
          cursor: cs.getPropertyValue("--accent").trim() || "#e6e6e6",
          selectionBackground: "rgba(128,128,128,0.35)",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      send({ type: "term_start", sessionId, cols: term.cols, rows: term.rows });

      const offData = term.onData((d: string) =>
        send({ type: "term_input", data: b64encode(d) }),
      );
      const offMsg = addHandler((msg) => {
        if (msg.type === "term_data") term.write(b64decode(msg.data));
        else if (msg.type === "term_exit")
          term.write("\r\n\x1b[2m[shell exited — switch tabs to restart]\x1b[0m\r\n");
      });

      const ro = new ResizeObserver(() => {
        try {
          fit.fit();
          send({ type: "term_resize", cols: term.cols, rows: term.rows });
        } catch {}
      });
      ro.observe(hostRef.current);
      term.focus();

      cleanup = () => {
        offData.dispose();
        offMsg();
        ro.disconnect();
        send({ type: "term_stop" });
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [sessionId, send, addHandler]);

  return <div ref={hostRef} className="flex-1 min-h-0 px-1.5 pb-1.5" />;
}
