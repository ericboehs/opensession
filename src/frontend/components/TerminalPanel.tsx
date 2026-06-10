import React, { useEffect, useRef } from "react";
import type { TranscriptEntry } from "../lib/types";

interface Props {
  entries: TranscriptEntry[];
}

/** Live terminal view of every Bash command the session has run. */
export function TerminalPanel({ entries }: Props) {
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
