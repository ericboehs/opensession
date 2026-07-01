import React, { useEffect, useRef, useState } from "react";
import {
  fetchRepos,
  attachRepoApi,
  detachRepoApi,
  fetchRepoSwitchable,
  switchPrimaryRepoApi,
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
 *
 * The primary chip doubles as a repo *switcher* — for when the wrong repo was
 * picked at creation. It's only interactive while the session is fresh (no
 * committed/uncommitted work), so a switch never silently strands work; once the
 * session has changes the chip goes back to a plain label.
 */
export function RepoBar({ sessionId, primaryRepo, branch, initialAttached }: Props) {
  const [attached, setAttached] = useState<AttachedRepo[]>(initialAttached);
  const [primary, setPrimary] = useState(primaryRepo);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [switchable, setSwitchable] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const switchRef = useRef<HTMLDivElement>(null);

  // Keep in sync if the session prop changes (e.g. the agent attached one, or a
  // switch landed and the parent re-fetched).
  useEffect(() => setAttached(initialAttached), [JSON.stringify(initialAttached)]);
  useEffect(() => setPrimary(primaryRepo), [primaryRepo]);

  // Can this session's primary repo be switched? (fresh worktree only)
  useEffect(() => {
    fetchRepoSwitchable(sessionId).then(setSwitchable).catch(() => {});
  }, [sessionId, primary]);

  useEffect(() => {
    if ((open || switchOpen) && !repos.length)
      fetchRepos().then(setRepos).catch(() => {});
  }, [open, switchOpen]);

  useEffect(() => {
    if (!open && !switchOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current && !menuRef.current.contains(t)) setOpen(false);
      if (switchRef.current && !switchRef.current.contains(t)) setSwitchOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open, switchOpen]);

  const attachedIds = new Set(attached.map((r) => r.repo));
  const attachable = repos.filter(
    (p) => !p.sharedCheckout && p.id !== primary && !attachedIds.has(p.id),
  );
  // Switching can target any other repo (incl. shared-checkout like backstage).
  const switchTargets = repos.filter((p) => p.id !== primary);

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

  async function switchPrimary(repo: string) {
    setBusy(repo);
    setError(null);
    try {
      const res = await switchPrimaryRepoApi(sessionId, repo);
      setPrimary(res.repo);
      setAttached((prev) => prev.filter((r) => r.repo !== res.repo));
      setSwitchOpen(false);
    } catch (e: any) {
      setError(e.message || String(e));
      // A concurrent turn may have dirtied the worktree — hide the switcher.
      setSwitchable(false);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="repobar">
      {switchable ? (
        <div className="repobar-add-wrap" ref={switchRef}>
          <button
            className="repobar-chip repobar-chip-primary repobar-chip-switch"
            onClick={() => setSwitchOpen((o) => !o)}
            title="Wrong repo? Switch this session's primary repo (fresh sessions only)"
          >
            {primary} <span className="repobar-caret">▾</span>
          </button>
          {switchOpen && (
            <div className="repobar-menu">
              <div className="repobar-menu-head">Switch primary repo</div>
              {!repos.length ? (
                <div className="repobar-menu-empty">Loading…</div>
              ) : switchTargets.length ? (
                switchTargets.map((p) => (
                  <button
                    key={p.id}
                    className="repobar-menu-item"
                    onClick={() => switchPrimary(p.id)}
                    disabled={!!busy}
                  >
                    {busy === p.id ? "Switching…" : p.id}
                  </button>
                ))
              ) : (
                <div className="repobar-menu-empty">No other repos</div>
              )}
            </div>
          )}
        </div>
      ) : (
        <span className="repobar-chip repobar-chip-primary" title="Primary repo">
          {primary}
        </span>
      )}
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
