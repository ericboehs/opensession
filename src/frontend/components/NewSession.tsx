import React, { useState, useEffect } from "react";
import { fetchWorktrees } from "../lib/api";
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

export function NewSession({ onBack, send, addHandler, connected }: Props) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState("__new__");
  const [newBranch, setNewBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchWorktrees()
      .then(setWorktrees)
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
    if (!branch || !prompt.trim()) return;

    setError(null);
    setCreating(true);
    send({
      type: "create_session",
      branch,
      prompt: prompt.trim(),
      user: getCurrentUser(),
    });
  }

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

        <label>
          What should Michael do?
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Describe the task — Michael gets a fresh worktree on tella-fusion and starts right away."
            rows={6}
            disabled={creating}
          />
        </label>

        {error && <div className="form-error">{error}</div>}

        <button
          className="btn-create"
          onClick={handleCreate}
          disabled={
            creating ||
            !connected ||
            !prompt.trim() ||
            (!selectedWorktree || (selectedWorktree === "__new__" && !newBranch.trim()))
          }
        >
          {creating ? "Setting up worktree & starting Michael…" : "Start session"}
        </button>
        {creating && (
          <div className="create-note">
            Creating the worktree and booting the session — you'll be dropped into it as soon as
            it's live (usually &lt; 30s).
          </div>
        )}
      </div>
    </div>
  );
}
