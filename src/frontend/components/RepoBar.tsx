import React, { useEffect, useState } from "react";
import {
  fetchRepos,
  attachRepoApi,
  detachRepoApi,
  fetchRepoSwitchable,
  switchPrimaryRepoApi,
  type RepoInfo,
  type AttachedRepo,
} from "../lib/api";
import { Menu } from "../ui/menu";
import { IconCheck, IconPlus, IconX, IconChevronRight } from "./icons";
import { RepoTile } from "./RepoTile";

interface Props {
  sessionId: string;
  primaryRepo: string;
  branch: string | null;
  initialAttached: AttachedRepo[];
}

/**
 * Repo segment of the session-header breadcrumb: `[icon] repo › title`.
 * Clicking the repo opens one menu that covers all cross-repo control —
 * switch the primary repo (any session, including a wrong choice made after
 * work started; the old worktree is left on disk so nothing is stranded, and
 * a switch-with-work is confirmed first), detach an attached repo, or attach
 * another (isolated worktree, same as the agent's michael-repos attach_repo
 * tool — both go through POST /api/sessions/:id/attach-repo).
 */
export function RepoBar({ sessionId, primaryRepo, branch, initialAttached }: Props) {
  const [attached, setAttached] = useState<AttachedRepo[]>(initialAttached);
  const [primary, setPrimary] = useState(primaryRepo);
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [switchable, setSwitchable] = useState(false); // false only for ask sessions
  const [hasWork, setHasWork] = useState(false); // already has edits/commits → confirm on switch
  const [busy, setBusy] = useState<string | null>(null); // trigger label while an action runs
  const [error, setError] = useState<string | null>(null);

  // Keep in sync if the session prop changes (e.g. the agent attached one, or a
  // switch landed and the parent re-fetched).
  useEffect(() => setAttached(initialAttached), [JSON.stringify(initialAttached)]);
  useEffect(() => setPrimary(primaryRepo), [primaryRepo]);

  // Can this session's primary repo be switched, and does it already have work?
  useEffect(() => {
    fetchRepoSwitchable(sessionId)
      .then(({ switchable, hasWork }) => {
        setSwitchable(switchable);
        setHasWork(hasWork);
      })
      .catch(() => {});
  }, [sessionId, primary]);

  useEffect(() => {
    if (open && !repos.length) fetchRepos().then(setRepos).catch(() => {});
  }, [open]);

  const attachedIds = new Set(attached.map((r) => r.repo));
  const attachable = repos.filter(
    (p) => !p.sharedCheckout && p.id !== primary && !attachedIds.has(p.id),
  );
  // Switching can target any other repo (incl. shared-checkout like backstage).
  const switchTargets = repos.filter((p) => p.id !== primary);

  async function attach(repo: string) {
    setBusy("Attaching…");
    setError(null);
    try {
      setAttached(await attachRepoApi(sessionId, repo, branch || undefined));
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setBusy(null);
    }
  }

  async function detach(repo: string) {
    setBusy("Detaching…");
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
    if (repo === primary) return;
    // Switching just repoints the session at another worktree — the current one
    // (branch, commits, edits) stays on disk. Confirm when there's work so the
    // move to a different codebase is a deliberate choice, not a surprise.
    if (
      hasWork &&
      !window.confirm(
        `Switch this workspace from ${primary} to ${repo}?\n\n` +
          `Your current changes stay in the ${primary} worktree${
            branch ? ` (branch ${branch})` : ""
          } — they won't move to ${repo}. You can reopen them from that branch.`,
      )
    )
      return;
    setBusy("Switching…");
    setError(null);
    try {
      const res = await switchPrimaryRepoApi(sessionId, repo, hasWork);
      setPrimary(res.repo);
      setHasWork(false); // the new worktree starts fresh
      setAttached((prev) => prev.filter((r) => r.repo !== res.repo));
    } catch (e: any) {
      setError(e.message || String(e));
      // Resync in case a concurrent turn changed the session's state.
      fetchRepoSwitchable(sessionId)
        .then(({ switchable, hasWork }) => {
          setSwitchable(switchable);
          setHasWork(hasWork);
        })
        .catch(() => {});
    } finally {
      setBusy(null);
    }
  }

  // Static (non-menu-item) row — current repo when it can't switch, attached rows.
  const staticRow = "flex items-center gap-2 rounded-md px-2.5 py-2 text-[13px] text-fg";

  return (
    <>
      <Menu.Root open={open} onOpenChange={setOpen}>
        <Menu.Trigger
          className="-mx-1.5 -my-1 flex min-w-0 shrink-0 cursor-pointer items-center gap-[7px] rounded-md border-0 bg-transparent px-1.5 py-1 text-[14px] font-medium text-fg hover:bg-hover data-[popup-open]:bg-hover"
          title="Repo — click to switch or attach another"
        >
          <RepoTile name={primary} />
          <span className="max-w-[180px] truncate">{busy ?? primary}</span>
          {attached.length > 0 && (
            <span
              className="text-[12px] text-dim"
              title={attached.map((r) => r.repo).join(", ")}
            >
              +{attached.length}
            </span>
          )}
        </Menu.Trigger>
        <Menu.Popup align="start" sideOffset={6} className="min-w-[230px]">
          {!repos.length ? (
            <div className="px-2.5 py-2 text-[12px] text-faint">Loading…</div>
          ) : (
            <>
              {switchable ? (
                // Fresh session: the repo is still a free choice — one select
                // list, current checked, click another to switch the worktree.
                [{ id: primary }, ...switchTargets].map((p) => (
                  <Menu.Item key={p.id} onClick={() => switchPrimary(p.id)}>
                    <RepoTile name={p.id} />
                    <span className="min-w-0 flex-1 truncate">{p.id}</span>
                    {p.id === primary && <IconCheck size={20} className="text-dim" />}
                  </Menu.Item>
                ))
              ) : (
                <div className={staticRow}>
                  <RepoTile name={primary} />
                  <span className="min-w-0 flex-1 truncate">{primary}</span>
                  <IconCheck size={20} className="text-dim" />
                </div>
              )}
              {attached.length > 0 && (
                <>
                  <Menu.Separator />
                  <Menu.Group>
                    <Menu.GroupLabel>Attached</Menu.GroupLabel>
                    {attached.map((r) => (
                      <div key={r.repo} className={staticRow} title={`${r.dir} — branch ${r.branch}`}>
                        <RepoTile name={r.repo} />
                        <span className="min-w-0 flex-1 truncate">
                          {r.repo} <span className="text-faint">· {r.branch}</span>
                        </span>
                        <button
                          className="cursor-pointer rounded border-0 bg-transparent p-0.5 text-faint hover:text-fg"
                          onClick={() => detach(r.repo)}
                          title="Detach (leaves the worktree on disk)"
                          aria-label={`Detach ${r.repo}`}
                        >
                          <IconX size={16} />
                        </button>
                      </div>
                    ))}
                  </Menu.Group>
                </>
              )}
              <Menu.Separator />
              <Menu.Group>
                <Menu.GroupLabel>Attach another repo</Menu.GroupLabel>
                {attachable.length ? (
                  attachable.map((p) => (
                    <Menu.Item
                      key={p.id}
                      onClick={() => attach(p.id)}
                      title="Attach to this session as an isolated worktree"
                    >
                      <RepoTile name={p.id} />
                      <span className="min-w-0 flex-1 truncate">{p.id}</span>
                      <IconPlus size={18} className="text-faint" />
                    </Menu.Item>
                  ))
                ) : (
                  <div className="px-2.5 py-1.5 text-[12px] text-faint">
                    No more repos to attach
                  </div>
                )}
              </Menu.Group>
              {!switchable ? (
                <div className="max-w-[240px] px-2.5 pt-1.5 pb-0.5 text-[11px] leading-snug text-faint">
                  Ask sessions read the shared checkout — there's no primary repo
                  to switch.
                </div>
              ) : (
                hasWork && (
                  <div className="max-w-[240px] px-2.5 pt-1.5 pb-0.5 text-[11px] leading-snug text-faint">
                    Switching keeps your current changes in the {primary} worktree
                    — they won't move to the new repo.
                  </div>
                )
              )}
            </>
          )}
        </Menu.Popup>
      </Menu.Root>
      {error && (
        <span className="max-w-[220px] truncate text-[11px] text-red" title={error}>
          {error}
        </span>
      )}
      {/* Breadcrumb separator between the repo and the session title. */}
      <IconChevronRight size={18} className="shrink-0 text-faint" />
    </>
  );
}
