import React, { useState, useEffect, useRef } from "react";
import { fetchWorktrees, fetchModels, fetchFileMentions, suggestBranch, type ModelOption } from "../lib/api";
import { getCurrentUser } from "./UserPicker";
import { splitAttachments, imageFilesFromPaste, type FileAttachment } from "../lib/images";
import { loadDraft, saveDraft, clearDraft } from "../lib/drafts";
import { ImageThumbs } from "./ImageThumbs";
import { FileChips } from "./FileChips";
import { useFileMentions } from "./useFileMentions";
import { IconPaperclip, IconChevronDown, IconCheck, IconSliders } from "./icons";
import type { WSServerMessage } from "../lib/types";
import { VoiceInput } from "./VoiceInput";
import { useIsPhone } from "../hooks/useIsPhone";
import { PaletteSelect } from "./PaletteSelect";
import { ModelEffortSelect } from "./ModelEffortSelect";

interface Props {
  /** Close the palette (Esc, backdrop click, or after a create without "Create more"). */
  onBack: () => void;
  send: (msg: any) => void;
  addHandler: (handler: (msg: WSServerMessage) => void) => () => void;
  connected: boolean;
  /** Prefill the prompt (e.g. from the Home "New session" box). */
  prefillPrompt?: string;
  /** When starting a chat inside a Project (folder), the chat joins this project… */
  projectId?: string;
  /** …and defaults to the project's shared repo + worktree (a sibling's branch). */
  forceRepo?: string;
  forceBranch?: string;
  /** Lets App render the pending chat shell before the created session appears
      in the polled session list. */
  onCreateStarted?: (draft: {
    prompt: string;
    mode: "ask" | "code";
    repo: string;
    branch: string | null;
    projectId?: string;
    model?: string;
    images?: string[];
  }) => void;
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

export function NewSession({ onBack, send, addHandler, connected, prefillPrompt, projectId, forceRepo, forceBranch, onCreateStarted }: Props) {
  const [prefill] = useState(readPrefill);
  const [mode, setMode] = useState<"ask" | "code">(prefill.mode);
  // In a Project, default to the folder's shared repo; else the prefill/filter repo.
  const [repo, setRepo] = useState(forceRepo || prefill.repo);
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // In a Project, default to a sibling's branch so the new chat reuses its
  // worktree; the user can still switch to "New branch" to fork a fresh one.
  const [selectedWorktree, setSelectedWorktree] = useState(forceBranch || "__new__");
  const [newBranch, setNewBranch] = useState(prefill.branch);
  // An explicit prefill (Home hand-off, deep link) wins; otherwise restore the
  // stored draft so closing the palette / navigating away doesn't lose a
  // half-written task. Mirrored back below; cleared on session_created.
  const [prompt, setPrompt] = useState(
    prefillPrompt || prefill.prompt || loadDraft("new-session").text,
  );
  // Whether the user has hand-edited the branch field. Once true we stop
  // auto-suggesting so we never clobber what they typed. A prefilled branch
  // (deep link) counts as already-owned.
  const [branchEdited, setBranchEdited] = useState(!!prefill.branch);
  const [suggestingBranch, setSuggestingBranch] = useState(false);
  const [images, setImages] = useState<string[]>(() => loadDraft("new-session").images);
  const [files, setFiles] = useState<FileAttachment[]>(() => loadDraft("new-session").files);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [defaultModel, setDefaultModel] = useState("");
  const [model, setModel] = useState(""); // "" = default
  // Footer controls from the palette design. effort is sent through
  // create_session but not yet consumed server-side (forward-compatible).
  const [effort, setEffort] = useState("high");
  // Keep the palette open after a create to fire off another task. Chosen from
  // the Create split-button's dropdown; the primary button reflects the mode.
  const [createMore, setCreateMore] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const createSplitRef = useRef<HTMLDivElement>(null);
  // Phones open on just the prompt — repo/base/model/effort have sensible
  // defaults and hide behind the sliders toggle until you actually need them.
  const isPhone = useIsPhone();
  const [showOptions, setShowOptions] = useState(false);
  const optionsVisible = !isPhone || showOptions;

  // MCP servers: empty by default (minimal context), users can opt in for specific ones
  const [selectedMcpServers, setSelectedMcpServers] = useState<string[]>([]);
  const availableMcpServers = [
    "linear",
    "slack",
    "stripe",
    "plain",
    "sentry",
    "ahrefs",
    "amplitude",
    "brex",
    "grafana",
    "incident",
    "tinybird",
    "workos",
  ];

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

  // Keep the draft store in sync so a dismissed palette can restore the work.
  useEffect(() => {
    saveDraft("new-session", { text: prompt, images, files });
  }, [prompt, images, files]);

  // Close the Create dropdown on an outside click.
  useEffect(() => {
    if (!createMenuOpen) return;
    function onDown(e: MouseEvent) {
      if (createSplitRef.current && !createSplitRef.current.contains(e.target as Node)) {
        setCreateMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [createMenuOpen]);

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaultModel(m.default);
      })
      .catch(() => {});
  }, []);

  // Worktrees are per-repo; refetch and reset the selection when it changes.
  // Inside a Project, snap back to the shared sibling branch, not "New branch".
  useEffect(() => {
    setSelectedWorktree(forceBranch || "__new__");
    fetchWorktrees(repo)
      .then(setWorktrees)
      .catch(() => setWorktrees([]));
  }, [repo, forceBranch]);

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

  // Registered from mount and gated on a ref set synchronously in handleCreate:
  // session_created is announced before the worktree even boots, so it can
  // arrive before a `creating`-gated effect would have registered this handler
  // — the palette would miss it (stuck on "creating", draft never cleared).
  const creatingRef = useRef(false);
  useEffect(() => {
    return addHandler((msg) => {
      if (!creatingRef.current) return;
      if (msg.type === "error") {
        creatingRef.current = false;
        setError(msg.message);
        setCreating(false);
      } else if (msg.type === "session_created") {
        creatingRef.current = false;
        // The prompt was consumed — drop the stored draft either way.
        clearDraft("new-session");
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
  }, [addHandler, createMore]);

  async function addAttachments(picked: FileList | File[]) {
    const { images: imgs, files: fls, rejected } = await splitAttachments(picked);
    if (imgs.length) setImages((prev) => [...prev, ...imgs]);
    if (fls.length) setFiles((prev) => [...prev, ...fls]);
    if (rejected.length) alert(`Couldn't attach:\n${rejected.join("\n")}`);
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
    creatingRef.current = true;
    // Workspace linkage: scoped to an existing workspace (the tab/sidebar +),
    // the chat joins it — sharing its worktree when reusing the sibling branch,
    // stacking a fresh worktree off it for a new branch. Unscoped, the default
    // is a brand-new Workspace + first Chat created together.
    const chatMode =
      mode === "ask" ? "ask" : selectedWorktree === "__new__" ? "stack" : "share";
    onCreateStarted?.({
      prompt: prompt.trim(),
      mode,
      repo,
      branch: mode === "ask" ? null : branch,
      ...(projectId ? { projectId } : {}),
      ...(model ? { model } : {}),
      ...(images.length ? { images } : {}),
    });
    send({
      type: "create_session",
      mode,
      repo,
      ...(projectId
        ? { workspaceId: projectId, chatMode }
        : { createWorkspace: {} }),
      branch: mode === "ask" ? "" : branch,
      prompt: prompt.trim(),
      user: getCurrentUser(),
      ...(model ? { model } : {}),
      effort,
      ...(selectedMcpServers.length ? { mcpServers: selectedMcpServers } : {}),
      ...(images.length ? { images } : {}),
      ...(files.length
        ? {
            files: files.map((f) =>
              f.path ? { name: f.name, path: f.path } : { name: f.name, dataUrl: f.dataUrl },
            ),
          }
        : {}),
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
  const createFromOptions = [
    {
      value: "__new__",
      label: projectId && forceBranch
        ? `New stacked branch (off ${forceBranch})`
        : "New branch",
    },
    ...worktrees.map((wt) => ({ value: wt.branch, label: wt.branch })),
    { value: "__ask__", label: "Ask — read-only on main", menuLabel: "Ask · read-only on main" },
  ];

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !creating) onBack();
      }}
    >
      <div className="palette-card" role="dialog" aria-label="New session">
        {/* Header: repo (left) · create-from (right). Hidden on phones until
            the options toggle in the footer opens it. */}
        {optionsVisible && (
        <div className="palette-header">
          <PaletteSelect
            className="palette-trigger palette-trigger-strong"
            title="Repository"
            value={repo}
            options={REPOS.map((p) => ({ value: p.id, label: p.label }))}
            onChange={setRepo}
            disabled={creating}
            ariaLabel="Repository"
            isPhone={isPhone}
          >
            <svg width="20" height="20" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M2 6h12" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            <span className="palette-trigger-label">
              {REPOS.find((p) => p.id === repo)?.label || repo}
            </span>
            <IconChevronDown className="palette-chevron" size={22} />
          </PaletteSelect>

          <PaletteSelect
            className="palette-trigger"
            title="What to create from"
            value={createFromValue}
            options={createFromOptions}
            onChange={onCreateFromChange}
            disabled={creating}
            ariaLabel="Create from"
            isPhone={isPhone}
            align="end"
          >
            <svg width="19" height="19" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="4" cy="4" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="4" cy="12" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <circle cx="12" cy="5.5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
              <path d="M4 5.7v4.6M4 8h4a4 4 0 004-4" stroke="currentColor" strokeWidth="1.3" />
            </svg>
            <span className="palette-trigger-label">{createFromLabel}</span>
            <IconChevronDown className="palette-chevron" size={22} />
          </PaletteSelect>
        </div>
        )}

        {/* Advanced: MCP servers */}
        {optionsVisible && (
        <div className="palette-advanced">
          <div className="palette-advanced-label">Connected services (optional)</div>
          <div className="palette-mcp-grid">
            {availableMcpServers.map((mcp) => (
              <label key={mcp} className="palette-mcp-checkbox">
                <input
                  type="checkbox"
                  checked={selectedMcpServers.includes(mcp)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedMcpServers((prev) => [...prev, mcp]);
                    } else {
                      setSelectedMcpServers((prev) => prev.filter((m) => m !== mcp));
                    }
                  }}
                  disabled={creating}
                  aria-label={`Enable ${mcp}`}
                />
                <span className="palette-mcp-label">{mcp}</span>
              </label>
            ))}
          </div>
        </div>
        )}

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
            {isPhone && (
              <button
                type="button"
                className={`palette-icon-btn palette-options-btn ${showOptions ? "is-on" : ""}`}
                onClick={() => setShowOptions((v) => !v)}
                disabled={creating}
                aria-label="Repo, branch and model options"
                aria-expanded={showOptions}
              >
                <IconSliders size={24} />
              </button>
            )}
            <button
              type="button"
              className="palette-icon-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={creating}
              title="Attach a file"
              aria-label="Attach a file"
            >
              <IconPaperclip size={24} />
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
          </div>

          <div className="palette-footer-right">
            {optionsVisible && (
              <ModelEffortSelect
                className="palette-pill"
                title="Model and reasoning effort"
                models={models}
                defaultModel={defaultModel}
                model={model}
                onModelChange={setModel}
                effort={effort}
                onEffortChange={setEffort}
                disabled={creating}
              />
            )}
            <VoiceInput
              disabled={creating}
              onText={(t) => {
                setPrompt((prev) => (prev.trim() ? `${prev.replace(/\s+$/, "")} ${t}` : t));
                promptRef.current?.focus();
              }}
            />

            <div className="palette-create-split" ref={createSplitRef}>
              <button
                className="palette-create palette-create-main"
                onClick={handleCreate}
                disabled={!canCreate}
              >
                {creating ? "Creating…" : createMore ? "Create more" : "Create"}
                <span className="palette-create-kbd">↵</span>
              </button>
              <button
                type="button"
                className={`palette-create palette-create-caret ${createMenuOpen ? "is-open" : ""}`}
                onClick={() => setCreateMenuOpen((v) => !v)}
                disabled={creating}
                aria-haspopup="menu"
                aria-expanded={createMenuOpen}
                aria-label="Create options"
              >
                <IconChevronDown size={22} />
              </button>
              {createMenuOpen && (
                <div className="palette-create-menu" role="menu">
                  {[
                    { more: false, title: "Create", desc: "Open the new session" },
                    { more: true, title: "Create more", desc: "Stay here to start another" },
                  ].map((opt) => (
                    <button
                      key={opt.title}
                      type="button"
                      role="menuitemradio"
                      aria-checked={createMore === opt.more}
                      className={`palette-create-menu-item ${createMore === opt.more ? "is-active" : ""}`}
                      onClick={() => {
                        setCreateMore(opt.more);
                        setCreateMenuOpen(false);
                      }}
                    >
                      <IconCheck
                        className="palette-create-menu-check"
                        size={22}
                        style={{ visibility: createMore === opt.more ? "visible" : "hidden" }}
                      />
                      <span className="palette-create-menu-text">
                        <span className="palette-create-menu-title">{opt.title}</span>
                        <span className="palette-create-menu-desc">{opt.desc}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
