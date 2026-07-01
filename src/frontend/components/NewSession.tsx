import React, { useState, useEffect, useRef } from "react";
import { fetchWorktrees, fetchModels, fetchFileMentions, suggestBranch, type ModelOption } from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { splitAttachments, imageFilesFromPaste, type FileAttachment } from "../lib/images";
import { ImageThumbs } from "./ImageThumbs";
import { FileChips } from "./FileChips";
import { useFileMentions } from "./useFileMentions";
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

// Repos a session can run against. tella-fusion is the default.
// Keep in sync with PROJECTS in src/server/worktree.ts.
const PROJECTS = [
  { id: "tella-fusion", label: "tella-fusion" },
  { id: "backstage", label: "backstage (Michael itself)" },
  { id: "gitops", label: "gitops" },
  { id: "infra", label: "infra" },
  { id: "shared-infra", label: "shared-infra" },
  { id: "gstreamer", label: "gstreamer" },
  { id: "gst-plugins-rs", label: "gst-plugins-rs" },
];

/** Deep-link prefill: /backstage/new?mode=ask|code&prompt=…&branch=…&project= */
function readPrefill() {
  const params = new URLSearchParams(location.search);
  return {
    mode: params.get("mode") === "ask" ? ("ask" as const) : ("code" as const),
    prompt: params.get("prompt") || "",
    branch: params.get("branch") || "",
    project: PROJECTS.some((p) => p.id === params.get("project"))
      ? params.get("project")!
      : "tella-fusion",
  };
}

export function NewSession({ onBack, send, addHandler, connected }: Props) {
  const [prefill] = useState(readPrefill);
  const [mode, setMode] = useState<"ask" | "code">(prefill.mode);
  const [project, setProject] = useState(prefill.project);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState("__new__");
  const [newBranch, setNewBranch] = useState(prefill.branch);
  const [prompt, setPrompt] = useState(prefill.prompt);
  // Whether the user has hand-edited the branch field. Once true we stop
  // auto-suggesting so we never clobber what they typed. A prefilled branch
  // (deep link) counts as already-owned.
  const [branchEdited, setBranchEdited] = useState(!!prefill.branch);
  const [suggestingBranch, setSuggestingBranch] = useState(false);
  const [images, setImages] = useState<string[]>([]);
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default

  // "@"-mention file autocomplete against the selected project's repo (no
  // session exists yet, so search by project).
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Hidden <input type="file"> driven by the "Add image" button — the mobile
  // path, since there's no clipboard paste there.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentions = useFileMentions({
    value: prompt,
    onChange: setPrompt,
    textareaRef: promptRef,
    mentionFetch: (q) => fetchFileMentions(q, undefined, project),
  });

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);

  // Worktrees are per-project; refetch and reset the selection when it changes.
  useEffect(() => {
    setSelectedWorktree("__new__");
    fetchWorktrees(project)
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  }, [project]);

  // Auto-suggest a branch name from the prompt (debounced Haiku call), but only
  // while the field is "ours" — once the user types in it (branchEdited) we back
  // off. The latest-request guard drops a stale response if the user starts
  // editing the branch while a suggestion is in flight.
  const branchEditedRef = useRef(branchEdited);
  branchEditedRef.current = branchEdited;
  const suggestSeqRef = useRef(0);
  useEffect(() => {
    if (mode !== "code" || selectedWorktree !== "__new__" || branchEdited) return;
    if (prompt.trim().length < 10) return;
    const seq = ++suggestSeqRef.current;
    const t = setTimeout(async () => {
      setSuggestingBranch(true);
      const branch = await suggestBranch(prompt.trim());
      setSuggestingBranch(false);
      // Drop if superseded by a newer prompt or the user grabbed the field.
      if (seq !== suggestSeqRef.current || branchEditedRef.current) return;
      if (branch) setNewBranch(branch);
    }, 700);
    return () => clearTimeout(t);
  }, [prompt, mode, selectedWorktree, branchEdited]);

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

  async function addAttachments(picked: FileList | File[]) {
    const { images: imgs, files: fls } = await splitAttachments(picked);
    if (imgs.length) setImages((prev) => [...prev, ...imgs]);
    if (fls.length) setFiles((prev) => [...prev, ...fls]);
  }

  function handlePaste(e: React.ClipboardEvent) {
    const imgs = imageFilesFromPaste(e);
    if (imgs.length) {
      e.preventDefault();
      void addAttachments(imgs);
    }
  }

  function handleCreate() {
    const branch = selectedWorktree === "__new__" ? newBranch.trim() : selectedWorktree;
    if (mode === "code" && !branch) return;
    if (!prompt.trim() && images.length === 0 && files.length === 0) return;

    setError(null);
    setCreating(true);
    send({
      type: "create_session",
      mode,
      project,
      branch: mode === "ask" ? "" : branch,
      prompt: prompt.trim(),
      user: getCurrentUser(),
      ...(model ? { model } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length ? { files: files.map((f) => ({ name: f.name, dataUrl: f.dataUrl })) } : {}),
    });
  }

  const canCreate =
    !creating &&
    connected &&
    (prompt.trim() || images.length > 0 || files.length > 0) &&
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
          Project
          <select
            value={project}
            onChange={(e) => setProject(e.target.value)}
            disabled={creating}
          >
            {PROJECTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

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
                <span className="label-row">
                  Branch name
                  {suggestingBranch && !branchEdited && (
                    <span className="branch-suggesting">✨ suggesting…</span>
                  )}
                </span>
                <input
                  type="text"
                  value={newBranch}
                  onChange={(e) => {
                    setBranchEdited(true);
                    setNewBranch(e.target.value);
                  }}
                  placeholder={suggestingBranch ? "naming it…" : "feature-name"}
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
          <div
            className="composer-input-wrap"
            onDrop={(e) => {
              if (e.dataTransfer?.files?.length) {
                e.preventDefault();
                void addAttachments(e.dataTransfer.files);
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            ref={mentions.inputWrapRef}
          >
            {mentions.popup}
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                // Caret has moved to the new value; re-evaluate after React commits.
                queueMicrotask(mentions.sync);
              }}
              onKeyDown={(e) => mentions.handleKeyDown(e)}
              onKeyUp={mentions.sync}
              onClick={mentions.sync}
              onBlur={() => setTimeout(mentions.close, 120)}
              onPaste={handlePaste}
              placeholder={
                mode === "ask"
                  ? "Ask anything about the codebase or product — read-only. Type @ to reference a file. Paste a screenshot or attach files with 📎."
                  : `Describe the task — Michael gets a fresh worktree on ${project} and starts right away. Type @ to reference a file. Paste a screenshot or attach files with 📎.`
              }
              rows={6}
              disabled={creating}
            />
            <ImageThumbs images={images} onRemove={(i) => setImages((p) => p.filter((_, idx) => idx !== i))} disabled={creating} />
            <FileChips files={files} onRemove={(i) => setFiles((p) => p.filter((_, idx) => idx !== i))} disabled={creating} />
          </div>
          <div className="composer-attach-row">
            <button
              type="button"
              className="btn-attach"
              onClick={() => fileInputRef.current?.click()}
              disabled={creating}
            >
              📎 Add file
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void addAttachments(e.target.files);
                // Reset so picking the same file again still fires onChange.
                e.target.value = "";
              }}
            />
          </div>
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
