import React, { useState } from "react";
import type { UnifiedSession, TranscriptEntry } from "../lib/types";
import { getCurrentUser } from "./UserPicker";

type Flavor = "build" | "learnings" | "analyze";

interface Props {
  session: UnifiedSession;
  entries: TranscriptEntry[];
  send: (msg: any) => void;
  connected: boolean;
}

/**
 * Spin a new session off the current transcript:
 *  - build:     ask → code handoff with conversation context (Devin's "spin-off")
 *  - learnings: code session that feeds durable learnings back into tella-fusion docs as a PR
 *  - analyze:   ask session reviewing what went well/wrong + better prompt
 */
export function SpinOffMenu({ session, entries, send, connected }: Props) {
  const [open, setOpen] = useState(false);
  const [flavor, setFlavor] = useState<Flavor | null>(null);
  const [branch, setBranch] = useState("");
  const [task, setTask] = useState("");
  const [starting, setStarting] = useState(false);

  const isAsk = session.mode === "ask";
  const hasContent = entries.some((e) => e.type === "assistant");
  if (!hasContent) return null;

  function pick(f: Flavor) {
    setFlavor(f);
    setOpen(false);
    if (f === "build") {
      setBranch(suggestBranch(session.title));
      setTask("Implement what we discussed above.");
    } else if (f === "learnings") {
      setBranch(`michael-learnings-${dateStamp()}`);
      setTask("");
    }
  }

  function start() {
    if (!flavor || starting) return;
    setStarting(true);

    const context = buildContext(entries, flavor === "build" ? 6000 : 9000);
    const me = getCurrentUser();

    if (flavor === "analyze") {
      send({
        type: "create_session",
        mode: "ask",
        branch: "",
        user: me,
        prompt:
          `Analyze this finished Michael session ("${session.title}") and report:\n` +
          `1. What was asked and what was delivered.\n` +
          `2. What went wrong or was wasted effort (wrong paths, retries, misunderstandings).\n` +
          `3. A rewritten version of the original prompt that would likely have succeeded in one shot.\n` +
          `4. Whether any repo docs (docs/kb/**, AGENTS.md, CLAUDE.md) could be updated to prevent ` +
          `the mistakes you found — quote the concrete text you would add.\n\n` +
          `## Conversation\n\n${context}`,
      });
      return;
    }

    if (flavor === "learnings") {
      send({
        type: "create_session",
        mode: "code",
        branch,
        user: me,
        prompt:
          `Feed the durable learnings from a Michael session back into this repo's documentation.\n\n` +
          `## Conversation (session "${session.title}")\n\n${context}\n\n## Task\n\n` +
          `Extract durable, non-obvious learnings from the conversation above: gotchas, architecture facts, ` +
          `runbook steps, conventions, anything a teammate or future agent session would benefit from knowing. ` +
          `Check whether each is already documented; skip session-specific noise. Add the genuinely new ones to ` +
          `the right place — docs/kb/**, AGENTS.md, CLAUDE.md, or a package README — keeping each addition ` +
          `short and factual, matching the surrounding style.` +
          (task.trim() ? `\n\nExtra guidance from ${me}: ${task.trim()}` : "") +
          `\n\nWhen done, commit on this branch and open a PR titled "docs: learnings from Michael session" ` +
          `with a body summarizing what you added and why. Do NOT merge the PR.`,
      });
      return;
    }

    // build
    send({
      type: "create_session",
      mode: "code",
      branch,
      user: me,
      prompt:
        `This coding session was spun off from an Ask session ("${session.title}"). ` +
        `The conversation below is context — the codebase exploration already happened there, ` +
        `so trust its conclusions but re-verify file paths before editing.\n\n` +
        `## Ask conversation\n\n${context}\n\n## Task\n\n${task.trim() || "Implement what was discussed above."}`,
    });
  }

  const needsBranch = flavor === "build" || flavor === "learnings";
  const canStart = connected && !starting && (!needsBranch || branch.trim());

  return (
    <div className="spinoff">
      <button className="btn-panel-toggle" onClick={() => setOpen(!open)} title="Spin off a new session from this one">
        Spin off ▾
      </button>

      {open && (
        <div className="spinoff-menu">
          {isAsk && (
            <button className="spinoff-item" onClick={() => pick("build")}>
              <span className="spinoff-item-title">Build this</span>
              <span className="spinoff-item-sub">Start a coding session with this conversation as context</span>
            </button>
          )}
          <button className="spinoff-item" onClick={() => pick("learnings")}>
            <span className="spinoff-item-title">Capture learnings → docs PR</span>
            <span className="spinoff-item-sub">Michael adds what was learned here to tella-fusion docs</span>
          </button>
          <button className="spinoff-item" onClick={() => pick("analyze")}>
            <span className="spinoff-item-title">Analyze session</span>
            <span className="spinoff-item-sub">What went well, what didn't, and a better prompt</span>
          </button>
        </div>
      )}

      {flavor && (
        <div className="spinoff-form">
          <div className="spinoff-form-title">
            {flavor === "build" ? "Build this" : flavor === "learnings" ? "Capture learnings → docs PR" : "Analyze session"}
          </div>

          {needsBranch && (
            <label>
              Branch
              <input
                className="mono-input"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
                disabled={starting}
              />
            </label>
          )}

          {flavor !== "analyze" && (
            <label>
              {flavor === "build" ? "Task" : "Extra guidance (optional)"}
              <textarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                rows={3}
                disabled={starting}
                placeholder={flavor === "learnings" ? "e.g. focus on the deploy gotchas we hit" : ""}
              />
            </label>
          )}

          <div className="spinoff-form-actions">
            <button className="btn-delete-cancel" onClick={() => setFlavor(null)} disabled={starting}>
              Cancel
            </button>
            <button className="btn-send" onClick={start} disabled={!canStart}>
              {starting ? "Starting…" : "Start session"}
            </button>
          </div>
          {starting && (
            <div className="spinoff-note">Booting the session — you'll be taken there automatically.</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact the conversation: always keep the opening message, then fill from the end. */
function buildContext(entries: TranscriptEntry[], budget: number): string {
  const turns = entries
    .filter((e) => e.type === "user" || e.type === "assistant")
    .map((e) => {
      const who = e.type === "user" ? "User" : "Michael";
      const limit = e.type === "user" ? 700 : 1500;
      return `**${who}:** ${truncate(e.content.trim(), limit)}`;
    });

  if (turns.length === 0) return "(empty)";

  const first = turns[0];
  const rest: string[] = [];
  let used = first.length;
  for (let i = turns.length - 1; i >= 1; i--) {
    if (used + turns[i].length > budget) break;
    rest.unshift(turns[i]);
    used += turns[i].length;
  }
  const skipped = turns.length - 1 - rest.length;
  return [first, skipped > 0 ? `*(… ${skipped} earlier messages omitted …)*` : null, ...rest]
    .filter(Boolean)
    .join("\n\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

function suggestBranch(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  return slug ? `${slug}` : `from-ask-${dateStamp()}`;
}

function dateStamp(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}
