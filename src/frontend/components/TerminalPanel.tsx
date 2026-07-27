import React, { useEffect, useRef, useState } from "react";
import type { TranscriptEntry, WSServerMessage } from "../lib/types";
import { canonicalToolName } from "./ToolCallBlock";

/**
 * The old single Terminal panel, split into two side-panel tabs (SessionViewer):
 * - CommandsPanel: read-only live view of every Bash command the agent has run.
 * - ShellPanel: real interactive terminals over server-side PTYs in the
 *   session's worktree — poke at the agent's checkout without leaving the
 *   browser. Rendered by Ghostty's VT core (libghostty-vt via WASM,
 *   ghostty-web) with an xterm.js fallback — see loadTerminalEngine.
 *   Multiple shell tabs, each its own PTY, multiplexed over the one
 *   session WebSocket by a per-tab `termId` on the term_* frames. A PTY dies
 *   with its tab's ×, the panel unmounting, or the socket — but NOT when
 *   switching side-panel tabs: SessionViewer keeps the ShellPanel mounted
 *   (hidden) once opened.
 *   Sandboxed sessions get their shells INSIDE the sandbox (docker exec /
 *   Daytona PTY — see src/server/terminals.ts); a dim banner says where each
 *   landed.
 */

/** Live terminal view of every Bash command the session has run. */
export function CommandsPanel({ entries }: { entries: TranscriptEntry[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const toolResults = new Map<string, TranscriptEntry>();
  for (const e of entries) {
    if (e.type === "tool_result" && e.toolUseId) toolResults.set(e.toolUseId, e);
  }

  const commands = entries.filter(
    (e) => e.type === "tool_use" && canonicalToolName(e.toolName) === "Bash"
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
        // opencode calls it `cmd`, the Claude SDK `command`.
        const raw = cmd.toolInput as { command?: string; cmd?: string } | undefined;
        const input = { command: raw?.command || raw?.cmd };
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

// ── Interactive shell tabs (xterm.js ↔ server PTYs over the session WS) ──

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

/** The pluggable terminal engine (constructors + extra Terminal options). */
interface TermEngine {
  Terminal: new (opts: object) => any;
  FitAddon: new () => any;
  extraOptions: object;
}

/**
 * Terminal engine for the shell tabs: Ghostty — the real Ghostty VT core
 * (libghostty-vt compiled to WASM, via coder's xterm.js-API-compatible
 * ghostty-web) — falling back to xterm.js when the WASM can't load (dev
 * mode, missing asset, exotic browser). Loaded once, shared by every tab.
 */
let enginePromise: Promise<TermEngine> | null = null;
function loadTerminalEngine(): Promise<TermEngine> {
  return (enginePromise ??= (async () => {
    try {
      const g = await import("ghostty-web");
      // Explicit wasm path — buildFrontend copies it out of the package into
      // the frontend dist and static-assets.ts serves it there; the bundled
      // chunk's import.meta.url can't locate the package-relative default.
      const ghostty = await g.Ghostty.load("/ghostty-vt.wasm");
      return {
        Terminal: g.Terminal as unknown as TermEngine["Terminal"],
        FitAddon: g.FitAddon as unknown as TermEngine["FitAddon"],
        extraOptions: { ghostty },
      };
    } catch (e) {
      console.warn("[shell] ghostty engine unavailable — using xterm.js", e);
      const [x, f] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      return {
        Terminal: x.Terminal as unknown as TermEngine["Terminal"],
        FitAddon: f.FitAddon as unknown as TermEngine["FitAddon"],
        extraOptions: {},
      };
    }
  })());
}

/** Random per-tab id — keys the PTY on the server (unique per socket; random
 *  so two viewers over one socket, or reopened tabs, can never collide). */
function newTermId(): string {
  return `t${Math.random().toString(36).slice(2, 10)}`;
}

interface ShellTabSpec {
  id: string;
  n: number;
}

/** The server caps PTYs per socket at 8 (terminals.ts) — mirror it here. */
const MAX_SHELL_TABS = 8;

export function ShellPanel({
  sessionId,
  send,
  addHandler,
  visible,
}: {
  sessionId: string;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  /** False while another side-panel tab covers the (still-mounted) panel. */
  visible: boolean;
}) {
  const [tabs, setTabs] = useState<ShellTabSpec[]>(() => [{ id: newTermId(), n: 1 }]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0]!.id);
  const nextN = useRef(2);

  function addTab() {
    if (tabs.length >= MAX_SHELL_TABS) return;
    const tab = { id: newTermId(), n: nextN.current++ };
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
  }

  function closeTab(id: string) {
    const idx = tabs.findIndex((t) => t.id === id);
    const next = tabs.filter((t) => t.id !== id);
    setTabs(next);
    if (activeId === id && next.length > 0) {
      setActiveId(next[Math.min(idx, next.length - 1)]!.id);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 px-3 pt-1.5 pb-1 shrink-0 flex-wrap">
        {tabs.map((t) => (
          <span
            key={t.id}
            className={`btn-small inline-flex items-center gap-1.5 cursor-pointer select-none ${
              t.id === activeId ? "!bg-active !text-fg" : ""
            }`}
            onClick={() => setActiveId(t.id)}
          >
            Terminal {t.n}
            <span
              role="button"
              aria-label={`Close terminal ${t.n}`}
              title="Close terminal (kills its PTY)"
              className="opacity-50 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              ×
            </span>
          </span>
        ))}
        {tabs.length < MAX_SHELL_TABS && (
          <button
            className="btn-small"
            onClick={addTab}
            title="New terminal tab"
            aria-label="New terminal tab"
          >
            +
          </button>
        )}
      </div>
      {tabs.length === 0 ? (
        <div className="panel-placeholder">
          <button className="btn-small" onClick={addTab}>
            Open a terminal
          </button>
        </div>
      ) : (
        // Every tab stays mounted (hidden when inactive) so switching tabs
        // never kills a PTY; only the × / panel unmount / socket does.
        tabs.map((t) => (
          <ShellView
            key={t.id}
            sessionId={sessionId}
            termId={t.id}
            send={send}
            addHandler={addHandler}
            visible={visible && t.id === activeId}
          />
        ))
      )}
    </div>
  );
}

function ShellView({
  sessionId,
  termId,
  send,
  addHandler,
  visible,
}: {
  sessionId: string;
  termId: string;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const showRef = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};

    void (async () => {
      // Dynamic import keeps the terminal engine out of the initial bundle.
      const { Terminal, FitAddon, extraOptions } = await loadTerminalEngine();
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
        ...extraOptions,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();

      send({ type: "term_start", sessionId, termId, cols: term.cols, rows: term.rows });

      const offData = term.onData((d: string) =>
        send({ type: "term_input", termId, data: b64encode(d) }),
      );
      const offMsg = addHandler((msg) => {
        // Frames are tagged with the termId of the PTY they belong to — route
        // only ours. (Untagged frames from a pre-multi-tab server — the cloud
        // upstream mid-deploy — fall through to every tab: single-tab compat.)
        const tagged = msg as { termId?: string };
        if (tagged.termId != null && tagged.termId !== termId) return;
        if (msg.type === "term_data") term.write(b64decode(msg.data));
        else if (msg.type === "term_ready" && msg.target !== "host")
          // Sandboxed sessions get their shell INSIDE the sandbox.
          term.write(
            `\x1b[2m[shell inside ${msg.target} sandbox — ${msg.cwd || ""}]\x1b[0m\r\n`,
          );
        else if (msg.type === "term_notice")
          term.write(`\x1b[2m[${msg.message}]\x1b[0m\r\n`);
        else if (msg.type === "term_exit")
          term.write(
            "\r\n\x1b[2m[shell exited — close this tab or open a new one]\x1b[0m\r\n",
          );
      });

      const refit = () => {
        // A hidden host (inactive tab / covered panel) measures 0×0 — fitting
        // then would garbage the PTY size; the show handler refits instead.
        const el = hostRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        try {
          fit.fit();
          send({ type: "term_resize", termId, cols: term.cols, rows: term.rows });
        } catch {}
      };
      showRef.current = () => {
        refit();
        term.focus();
      };
      const ro = new ResizeObserver(refit);
      ro.observe(hostRef.current);
      term.focus();

      cleanup = () => {
        offData.dispose();
        offMsg();
        ro.disconnect();
        send({ type: "term_stop", termId });
        term.dispose();
      };
    })();

    return () => {
      disposed = true;
      cleanup();
    };
  }, [sessionId, termId, send, addHandler]);

  // Becoming the visible tab again: refit (the panel may have resized while
  // this tab was hidden) and take focus.
  useEffect(() => {
    if (visible) showRef.current();
  }, [visible]);

  return (
    <div
      ref={hostRef}
      className={`flex-1 min-h-0 px-3 pb-1.5 ${visible ? "" : "hidden"}`}
    />
  );
}
