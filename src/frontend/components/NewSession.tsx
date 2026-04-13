import React, { useState, useEffect } from "react";
import { fetchWorktrees } from "../lib/api";
import { getCurrentUser } from "./UserPicker";

interface Props {
  onBack: () => void;
  send: (msg: any) => void;
  connected: boolean;
}

interface Worktree {
  branch: string;
  path: string;
}

export function NewSession({ onBack, send, connected }: Props) {
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    fetchWorktrees()
      .then(setWorktrees)
      .catch(() => {});
  }, []);

  function handleCreate() {
    const branch = selectedWorktree === "__new__" ? newBranch.trim() : selectedWorktree;
    if (!branch || !prompt.trim()) return;

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
        <div className="viewer-title">New Session</div>
      </div>

      <div className="new-session-form">
        <label>
          Worktree
          <select
            value={selectedWorktree}
            onChange={(e) => setSelectedWorktree(e.target.value)}
          >
            <option value="">Select a worktree...</option>
            {worktrees.map((wt) => (
              <option key={wt.branch} value={wt.branch}>
                {wt.branch}
              </option>
            ))}
            <option value="__new__">+ Create new branch</option>
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
            />
          </label>
        )}

        <label>
          Initial prompt
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="What should Claude do?"
            rows={6}
          />
        </label>

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
          {creating ? "Creating..." : "Start Session"}
        </button>
      </div>
    </div>
  );
}
