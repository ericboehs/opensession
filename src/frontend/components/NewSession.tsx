import React, { useState, useEffect, useRef } from "react";
import { fetchWorktrees, fetchModels, fetchFileMentions, suggestBranch, type ModelOption } from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { splitAttachments, imageFilesFromPaste, type FileAttachment } from "../lib/images";
import { ImageThumbs } from "./ImageThumbs";
import { FileChips } from "./FileChips";
import { useFileMentions } from "./useFileMentions";
import { IconBolt, IconMap, IconPaperclip } from "./icons";
import type { WSServerMessage } from "../lib/types";

interface Props {
  /** Close the palette (Esc, backdrop click, or after a create without "Create more"). */
  onBack: () => void;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
  /** Prefill the prompt (e.g. from the Home "New session" box). */
  prefillPrompt?: string;
}

interface Worktree {
  branch: string;
  path: string;
}

// Repos a session can run against. tella-fusion is the default.
// Keep in sync with REPOS in src/server/worktree.ts.
const REPOS = [
  { id: "tella-fusion", label: "tella-fusion" },
  { id: "backstage", label: "backstage (Michael itself)" },
  { id: "gitops", label: "gitops" },
  { id: "infra", label: "infra" },
  { id: "shared-infra", label: "shared-infra" },
  { id: "gstreamer", label: "gstreamer" },
  { id: "gst-plugins-rs", label: "gst-plugins-rs" },
];

const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

// The repo the sidebar is currently filtered to (persisted by Sidebar.tsx under
// this key). When set to a real repo, a new session should default to it so
// creating from a repo-filtered view lands on that repo — not always tella-fusion.
function filteredRepo(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem("michael-sidebar-filter") || "{}");
    return typeof v.repo === "string" && REPOS.some((p) => p.id === v.repo)
      ? v.repo
      : null;
  } catch {
    return null;
  }
}

/** Deep-link prefill: /backstage/new?mode=ask|code&prompt=…&branch=…&repo= */
function readPrefill() {
  const params = new URLSearchParams(location.search);
  // An explicit ?repo= wins (legacy ?project= still honored); otherwise fall
  // back to the sidebar's repo filter, then to tella-fusion.
  const repoParam = params.get("repo") ?? params.get("project");
  const repo = REPOS.some((p) => p.id === repoParam)
    ? repoParam!
    : filteredRepo() || "tella-fusion";
  return {
    mode: params.get("mode") === "ask" ? ("ask" as const) : ("code" as const),
    prompt: params.get("prompt") || "",
    branch: params.get("branch") || "",
    repo,
  };
}

/** Fallback branch name from the prompt when Haiku's auto-suggest hasn't landed. */
function slugifyBranch(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .slice(0, 6)
    .join("-");
  return slug || "new-session";
}

const isCodexModel = (m: string) => m.startsWith("gpt") || m.startsWith("codex") || m.startsWith("o");

export function NewSession({ onBack, send, addHandler, connected, prefillPrompt }: Props) {
  const [prefill] = useState(readPrefill);
  const [mode, setMode] = useState<"ask" | "code">(prefill.mode);
  const [repo, setRepo] = useState(prefill.repo);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  const [selectedWorktree, setSelectedWorktree] = useState("__new__");
  const [newBranch, setNewBranch] = useState(prefill.branch);
  const [prompt, setPrompt] = useState(prefillPrompt || prefill.prompt);
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
  // Footer controls from the palette design. effort/fast/plan are sent through
  // create_session but not yet consumed server-side (forward-compatible).
  const [effort, setEffort] = useState("high");
  const [fast, setFast] = useState(false);
  const [plan, setPlan] = useState(false);
  // Keep the palette open after a create to fire off another task.
  const [createMore, setCreateMore] = useState(false);

  // "@"-mention file autocomplete against the selected repo's repo (no
  // session exists yet, so search by repo).
  const promptRef = useRef<HTMLTextAreaElement>(null);
  // Hidden <input type="file"> driven by the "Add file" button — the mobile
  // path, since there's no clipboard paste there.
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mentions = useFileMentions({
    value: prompt,
    onChange: setPrompt,
    textareaRef: promptRef,
    mentionFetch: (q) => fetchFileMentions(q, undefined, repo),
  });

  // Focus the prompt as soon as the palette opens.
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);

  // Worktrees are per-repo; refetch and reset the selection when it changes.
  useEffect(() => {
    setSelectedWorktree("__new__");
    fetchWorktrees(repo)
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  }, [repo]);

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
      } else if (msg.type === "session_created") {
        // With "Create more" on, stay in the palette and reset for the next task
        // (App still navigates into the created session behind the overlay). Off,
        // close and let App drop us into the new session.
        if (createMore) {
          setCreating(false);
          setPrompt("");
          setImages([]);
          setFiles([]);
          setNewBranch("");
          setBranchEdited(false);
          setError(null);
          promptRef.current?.focus();
        } else {
          // Close the palette; App's global session_created handler drops us
          // into the newly created session behind it.
          onBack();
        }
      }
    });
  }, [creating, addHandler, createMore]);

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
    if (!canCreate) return;
    const branch =
      selectedWorktree === "__new__"
        ? newBranch.trim() || slugifyBranch(prompt)
        : selectedWorktree;

    setError(null);
    // With "Create more" off, App tears down the palette when the
    // session_created event arrives (and drops us into the new session).
    setCreating(true);
    send({
      type: "create_session",
      mode,
      repo,
      branch: mode === "ask" ? "" : branch,
      prompt: prompt.trim(),
      user: getCurrentUser(),
      ...(model ? { model } : {}),
      effort,
      fast,
      plan,
      ...(images.length ? { images } : {}),
      ...(files.length ? { files: files.map((f) => ({ name: f.name, dataUrl: f.dataUrl })) } : {}),
    });
  }

  const canCreate =
    !creating &&
    connected &&
    (prompt.trim() || images.length > 0 || files.length > 0) &&
    (mode === "ask" || selectedWorktree !== "" );

  // "Create from…" combines the mode + base into one control.
  const createFromValue = mode === "ask" ? "__ask__" : selectedWorktree;
  function onCreateFromChange(v: string) {
    if (v === "__ask__") {
      setMode("ask");
    } else {
      setMode("code");
      setSelectedWorktree(v);
    }
  }
  const createFromLabel =
    mode === "ask"
      ? "Ask · read-only"
      : selectedWorktree === "__new__"
        ? "New branch"
        : selectedWorktree;

  const effectiveModel = model || defaultModel;
  const modelLabel =
    models.find((m) => m.id === effectiveModel)?.label || effectiveModel || "Default";

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !creating) onBack();
      }}
    >
      <div className="palette-card" role="dialog" aria-label="New session">
        {/* Header: repo (left) · create-from (right) */}
        <div className="palette-header">
          <div className="palette-trigger palette-trigger-strong" title="Repository">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M2 6h12" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            <span className="palette-trigger-label">
              {REPOS.find((p) => p.id === repo)?.label || repo}
            </span>
            <span className="palette-chevron">▾</span>
            <select
              className="palette-select-overlay"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              disabled={creating}
              aria-label="Repository"
            >
              {REPOS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="palette-trigger" title="What to create from">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="4" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="4" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="12" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <path d="M4 5.7v4.6M4 8h4a4 4 0 004-4" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            <span className="palette-trigger-label">{createFromLabel}</span>
            <span className="palette-chevron">▾</span>
            <select
              className="palette-select-overlay"
              value={createFromValue}
              onChange={(e) => onCreateFromChange(e.target.value)}
              disabled={creating}
              aria-label="Create from"
            >
              <option value="__new__">New branch</option>
              {worktrees.map((wt) => (
                <option key={wt.branch} value={wt.branch}>
                  {wt.branch}
                </option>
              ))}
              <option value="__ask__">Ask — read-only on main</option>
            </select>
          </div>
        </div>

        {/* Prompt */}
        <div
          className="palette-body"
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
            className="palette-textarea"
            value={prompt}
            onChange={(e) => {
              setPrompt(e.target.value);
              queueMicrotask(mentions.sync);
            }}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter creates (unless the mention popup is capturing keys).
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                handleCreate();
                return;
              }
              mentions.handleKeyDown(e);
            }}
            onKeyUp={mentions.sync}
            onClick={mentions.sync}
            onBlur={() => setTimeout(mentions.close, 120)}
            onPaste={handlePaste}
            placeholder="What do you want to work on?"
            disabled={creating}
          />
          <ImageThumbs images={images} onRemove={(i) => setImages((p) => p.filter((_, idx) => idx !== i))} disabled={creating} />
          <FileChips files={files} onRemove={(i) => setFiles((p) => p.filter((_, idx) => idx !== i))} disabled={creating} />
        </div>

        {error && <div className="palette-error">{error}</div>}

        {/* Footer toolbar */}
        <div className="palette-footer">
          <div className="palette-footer-left">
            <div className="palette-pill" title="Model">
              <span className={`composer-model-dot ${isCodexModel(effectiveModel) ? "dot-codex" : "dot-claude"}`} />
              <span className="palette-pill-label">{modelLabel}</span>
              <span className="palette-chevron">▾</span>
              <select
                className="palette-select-overlay"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={creating}
                aria-label="Model"
              >
                <option value="">Default{defaultModel ? ` — ${defaultModel}` : ""}</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.provider === "codex" ? "OpenAI Codex" : "Claude"})
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              className={`palette-icon-btn ${fast ? "is-on" : ""}`}
              onClick={() => setFast((v) => !v)}
              disabled={creating}
              title={`Fast mode ${fast ? "on" : "off"} (not yet wired server-side)`}
              aria-pressed={fast}
            >
              <IconBolt size={17} />
            </button>

            <div className="palette-pill" title="Reasoning effort (not yet wired server-side)">
              <span className="palette-effort-icon" aria-hidden="true">
                <span /><span /><span />
              </span>
              <span className="palette-pill-label">{EFFORTS.find((e) => e.id === effort)?.label}</span>
              <span className="palette-chevron">▾</span>
              <select
                className="palette-select-overlay"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                disabled={creating}
                aria-label="Reasoning effort"
              >
                {EFFORTS.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              className={`palette-icon-btn ${plan ? "is-on" : ""}`}
              onClick={() => setPlan((v) => !v)}
              disabled={creating}
              title={`Plan mode ${plan ? "on" : "off"} (not yet wired server-side)`}
              aria-pressed={plan}
            >
              <IconMap size={17} />
            </button>
          </div>

          <div className="palette-footer-right">
            <button
              type="button"
              className="palette-icon-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={creating}
              title="Attach a file"
              aria-label="Attach a file"
            >
              <IconPaperclip size={17} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) void addAttachments(e.target.files);
                e.target.value = "";
              }}
            />

            <button
              type="button"
              className={`palette-switch ${createMore ? "is-on" : ""}`}
              onClick={() => setCreateMore((v) => !v)}
              disabled={creating}
              title="Keep this open after creating to start another"
              aria-pressed={createMore}
            >
              <span className="palette-switch-track">
                <span className="palette-switch-knob" />
              </span>
              Create more
            </button>

            <button className="palette-create" onClick={handleCreate} disabled={!canCreate}>
              {creating ? "Creating…" : "Create"}
              <span className="palette-create-kbd">↵</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
