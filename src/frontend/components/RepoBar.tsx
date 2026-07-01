import React, { useEffect, useRef, useState } from "react";
import {
  fetchRepos,
  attachRepoApi,
  detachRepoApi,
  type RepoInfo,
  type AttachedRepo,
} from "../lib/api";

interface Props {
  sessionId: string;
  primaryRepo: string;
  branch: string | null;
  initialAttached: AttachedRepo[];
}

/**
 * Cross-repo control for a code session: shows the primary repo plus any
 * attached repos (each an isolated worktree) and lets you attach another via a
 * dropdown. Mirrors the agent's michael-repos attach_repo tool — both go through
 * POST /api/sessions/:id/attach-repo.
 */
export function RepoBar({ sessionId, primaryRepo, branch, initialAttached }: Props) {
  const [attached, setAttached] = useState<AttachedRepo[]>(initialAttached);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Keep in sync if the session prop changes (e.g. the agent attached one).
  useEffect(() => setAttached(initialAttached), [JSON.stringify(initialAttached)]);

  useEffect(() => {
    if (open && !repos.length) fetchRepos().then(setRepos).catch(() => {});
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const attachedIds = new Set(attached.map((r) => r.repo));
  const attachable = repos.filter(
    (p) => !p.sharedCheckout && p.id !== primaryRepo && !attachedIds.has(p.id),
  );

  async function attach(repo: string) {
    setBusy(repo);
    setError(null);
    try {
      setAttached(await attachRepoApi(sessionId, repo, branch || undefined));
      setOpen(false);
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function detach(repo: string) {
    setBusy(repo);
    setError(null);
    try {
      setAttached(await detachRepoApi(sessionId, repo));
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="repobar">
      <span className="repobar-chip repobar-chip-primary" title="Primary repo">
        {primaryRepo}
      </span>
      {attached.map((r) => (
        <span key={r.repo} className="repobar-chip" title={`${r.dir} — branch ${r.branch}`}>
          {r.repo}
          <button
            className="repobar-detach"
            onClick={() => detach(r.repo)}
            disabled={busy === r.repo}
            title="Detach (leaves the worktree on disk)"
          >
            ×
          </button>
        </span>
      ))}
      <div className="repobar-add-wrap" ref={menuRef}>
        <button
          className="repobar-add"
          onClick={() => setOpen((o) => !o)}
          title="Attach another repo to this session (isolated worktree)"
        >
          + repo
        </button>
        {open && (
          <div className="repobar-menu">
            {!repos.length ? (
              <div className="repobar-menu-empty">Loading…</div>
            ) : attachable.length ? (
              attachable.map((p) => (
                <button
                  key={p.id}
                  className="repobar-menu-item"
                  onClick={() => attach(p.id)}
                  disabled={!!busy}
                >
                  {busy === p.id ? "Attaching…" : p.id}
                </button>
              ))
            ) : (
              <div className="repobar-menu-empty">No more repos to attach</div>
            )}
          </div>
        )}
      </div>
      {error && <span className="repobar-error">{error}</span>}
    </div>
  );
}
