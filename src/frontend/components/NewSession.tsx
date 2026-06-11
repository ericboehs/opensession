import React, { useState, useEffect } from "react";
import { fetchWorktrees, fetchModels, type ModelOption } from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import type { WSServerMessage } from "../lib/types";

interface Props {
  onBack: () => void;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
}

interface Worktree {
  branch: string;
  path: string;
}

/** Deep-link prefill: /backstage/new?mode=ask|code&prompt=…&branch=… */
function readPrefill() {
  const params = new URLSearchParams(location.search);
  return {
    mode: params.get("mode") === "ask" ? ("ask" as const) : ("code" as const),
    prompt: params.get("prompt") || "",
    branch: params.get("branch") || "",
  };
}

export function NewSession({ onBack, send, addHandler, connected }: Props) {
  const [prefill] = useState(readPrefill);
  const [mode, setMode] = useState<"ask" | "code">(prefill.mode);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState("__new__");
  const [newBranch, setNewBranch] = useState(prefill.branch);
  const [prompt, setPrompt] = useState(prefill.prompt);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default

  useEffect(() => {
    fetchWorktrees()
      .then(setWorktrees)
      .catch(() => {});
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!creating) return;
    return addHandler((msg) => {
      if (msg.type === "error") {
        setError(msg.message);
        setCreating(false);
      }
      // session_created is handled globally in App → navigates into the session
    });
  }, [creating, addHandler]);

  function handleCreate() {
    const branch = selectedWorktree === "__new__" ? newBranch.trim() : selectedWorktree;
    if (mode === "code" && !branch) return;
    if (!prompt.trim()) return;

    setError(null);
    setCreating(true);
    send({
      type: "create_session",
      mode,
      branch: mode === "ask" ? "" : branch,
      prompt: prompt.trim(),
      user: getCurrentUser(),
      ...(model ? { model } : {}),
    });
  }

  const canCreate =
    !creating &&
    connected &&
    prompt.trim() &&
    (mode === "ask" ||
      (selectedWorktree && (selectedWorktree !== "__new__" || newBranch.trim())));

  return (
    <div className="new-session">
      <div className="viewer-header">
        <button className="btn-back" onClick={onBack}>
          ← Back
        </button>
        <div className="viewer-title">New session</div>
      </div>

      <div className="new-session-form">
        <label>
          Mode
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as "ask" | "code")}
            disabled={creating}
          >
            <option value="code">Code — fresh worktree, can ship a PR</option>
            <option value="ask">Ask — read-only Q&A on main</option>
          </select>
        </label>

        {mode === "code" && (
          <>
            <label>
              Branch / worktree
              <select
                value={selectedWorktree}
                onChange={(e) => setSelectedWorktree(e.target.value)}
                disabled={creating}
              >
                <option value="__new__">+ Create new branch</option>
                {worktrees.map((wt) => (
                  <option key={wt.branch} value={wt.branch}>
                    {wt.branch}
                  </option>
                ))}
              </select>
            </label>

            {selectedWorktree === "__new__" && (
              <label>
                Branch name
                <input
                  type="text"
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="feature-name"
                  disabled={creating}
                />
              </label>
            )}
          </>
        )}

        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)} disabled={creating}>
            <option value="">Default{defaultModel ? ` — ${defaultModel}` : ""}</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} ({m.provider === "codex" ? "OpenAI Codex" : "Claude"})
              </option>
            ))}
          </select>
        </label>

        <label>
          What should Michael do?
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              mode === "ask"
                ? "Ask anything about the codebase or product — read-only."
                : "Describe the task — Michael gets a fresh worktree on tella-fusion and starts right away."
            }
            rows={6}
            disabled={creating}
          />
        </label>

        {error && <div className="form-error">{error}</div>}

        <button className="btn-create" onClick={handleCreate} disabled={!canCreate}>
          {creating
            ? mode === "ask"
              ? "Starting Michael…"
              : "Setting up worktree & starting Michael…"
            : "Start session"}
        </button>
        {creating && (
          <div className="create-note">
            Booting the session — you'll be dropped into it as soon as it's live.
          </div>
        )}
      </div>
    </div>
  );
}
