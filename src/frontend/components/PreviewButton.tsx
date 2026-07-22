import { useEffect, useRef, useState } from "react";
import {
  fetchPreview,
  startPreviewApi,
  stopPreviewApi,
  capturePreviewShot,
  type PreviewStatus,
} from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { BASE_PATH } from "../lib/base";
import { withPreviewPath } from "../lib/preview-url";
import { Tooltip } from "../ui/tooltip";
import { CopyCheck, useCopy } from "../ui/copy";
import {
  IconArrowUpRight,
  IconCamera,
  IconChevronDown,
  IconLink,
  IconPlay,
  IconPlayOutline,
} from "./icons";

// Any worktree session gets the control; whether a repo can actually boot a
// preview comes back on the status itself (`bootable` — repo-committed
// .opensession/start.sh → configured previewCommand → tella-local fallback).
// Repos with no mechanism show a disabled button explaining what to add.
function isPreviewable(session: UnifiedSession): boolean {
  return !!session.worktreeDir;
}

// Where the boot-script contract is documented (shown when a repo has no
// preview boot mechanism yet).
const PREVIEW_DOCS_URL =
  "https://github.com/tellahq/backstage/blob/master/deploy/sandbox/README.md#previews-in-sandboxes-phase-4a";

/**
 * Header control for a session's local dev server ("Preview"). When the
 * webapp is up it links to it (`https://<host>:<httpsPort>` — a Caddy-fronted
 * secure origin over the tailnet); when it's off, a ▶ play button starts it
 * (runs the repo's preview boot script in the worktree), showing a
 * "Starting…" state until the server is listening. A caret popover lists the
 * dev services and can stop them. Renders for any session with a worktree;
 * repos without a boot mechanism get a disabled state pointing at the docs.
 */
export function PreviewButton({
  session,
  onAttachImage,
  onStatusChange,
  variant = "bar",
}: {
  session: UnifiedSession;
  /** When set, the snapshot modal offers "Attach to chat" (stages the PNG as a
   *  composer image, like a paste). */
  onAttachImage?: (dataUrl: string) => void;
  /** Mirrors the polled status to the parent so other preview affordances can
   *  appear and disappear with the dev server without polling it twice. */
  onStatusChange?: (status: PreviewStatus | null) => void;
  /** "bar" = the full segmented split button (right panel's action row);
   *  "header" = a single state-colored ▶ icon for the session header, sized to
   *  match the panel-toggle icon it sits beside. Right-click opens the dev
   *  services popover (stop / snapshot). */
  variant?: "bar" | "header";
}) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const [snapping, setSnapping] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const [shotError, setShotError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { copied, copy } = useCopy();

  const previewable = isPreviewable(session);

  useEffect(() => {
    onStatusChange?.(status);
  }, [onStatusChange, status]);

  // Poll the dev-server status while this session is open. Poll faster while a
  // bring-up is in flight so the button flips to the live link promptly; `ss`
  // is cheap and only the active SessionViewer is mounted.
  const busy = starting || (status?.starting ?? false);
  useEffect(() => {
    if (!previewable) {
      setStatus(null);
      return;
    }
    let alive = true;
    const load = () =>
      fetchPreview(session.id)
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, busy ? 3000 : 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session.id, previewable, busy]);

  // Once the webapp is actually up, drop the optimistic "starting" flag.
  useEffect(() => {
    if (status?.running) setStarting(false);
  }, [status?.running]);

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!previewable || !status) return null;

  // The webapp is only openable once Caddy has fronted it with an HTTPS origin
  // (previewUrl). A secure origin is required for the app to load fully.
  const running = status.running && status.previewUrl != null;
  // Deep-link to the route the agent flagged (set_preview_path), so the human
  // lands on the feature under test instead of the app root.
  const url = status.previewUrl
    ? withPreviewPath(status.previewUrl, session.previewPath)
    : "#";
  const anyRunning = status.services.some((s) => s.running);
  const isStarting = busy && !running;
  // Absent on pre-field servers — treat as bootable so the button still works
  // against a not-yet-restarted backend.
  const bootable = status.bootable !== false;
  const notBootableHint = `No preview boot mechanism for this repo — commit an .opensession/start.sh to the repo, or set previewCommand on its repos config entry`;

  // Same-origin interstitial that waits for the boot and then redirects itself
  // to the preview (PreviewWait.tsx). The agent-flagged deep link rides along
  // so the redirect lands where a click on the live link would.
  const waitUrl =
    `${BASE_PATH}/preview-wait/${encodeURIComponent(session.id)}` +
    (session.previewPath ? `?path=${encodeURIComponent(session.previewPath)}` : "");

  async function start() {
    // Poll lag can leave a Start affordance up when the server is already
    // running — nothing to wait for, open the app directly. (Out-of-scope
    // origin, so installed PWAs hand this to a normal browser context.)
    if (status?.running && status.previewUrl) {
      window.open(url, "_blank", "noopener");
      return;
    }
    // Popup-blocker-safe "open when ready": window.open must fire synchronously
    // inside the click gesture, but the preview URL doesn't exist yet — so open
    // the interstitial NOW and let it redirect itself once the status endpoint
    // reports running. On the iOS PWA this opens the in-app browser view — a
    // new context, never replacing the app window. A blocked open returns null
    // and simply degrades to today's inline starting state.
    const wait = window.open(waitUrl, "_blank");
    setStarting(true);
    try {
      const s = await startPreviewApi(session.id);
      setStatus(s);
      // Nothing actually started (repo not bootable, sandbox gate off) — don't
      // leave the interstitial spinning toward a boot that will never come.
      if (!s.running && !s.starting) wait?.close();
    } catch {
      setStarting(false);
      wait?.close();
    }
  }

  async function stop() {
    setStopping(true);
    try {
      setStatus(await stopPreviewApi(session.id));
      setStarting(false);
    } catch {
    } finally {
      setStopping(false);
    }
  }

  async function snap() {
    if (snapping) return;
    setSnapping(true);
    setShotError(null);
    try {
      setShot(await capturePreviewShot(session.id));
    } catch (e: any) {
      setShotError(e.message);
      setShot(null);
    }
    setSnapping(false);
  }

  // Shared snapshot preview modal — rendered by both layouts.
  const snapshotModal = (shot || shotError) && (
    <div
      className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          setShot(null);
          setShotError(null);
        }
      }}
    >
      <div className="bg-raised border border-line rounded-panel shadow-2xl p-3 max-w-[90vw] max-h-[90vh] flex flex-col gap-2.5">
        {shotError ? (
          <div className="text-red text-[13px] px-2 py-4">{shotError}</div>
        ) : (
          <img
            src={shot!}
            alt="Preview screenshot"
            className="max-w-full max-h-[75vh] object-contain rounded-md border border-line"
          />
        )}
        <div className="flex items-center gap-2 justify-end">
          {shot && onAttachImage && (
            <button
              className="btn-create"
              style={{ padding: "6px 14px" }}
              onClick={() => {
                onAttachImage(shot);
                setShot(null);
              }}
            >
              Attach to chat
            </button>
          )}
          {shot && (
            <a className="btn-small" href={shot} download={`preview-${session.id}.png`}>
              Download
            </a>
          )}
          <button
            className="btn-small"
            onClick={() => {
              setShot(null);
              setShotError(null);
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );

  // Shared dev-services popover — the stop/start control and per-service list.
  // In header mode it also carries the snapshot action (there's no caret for it).
  const servicesPopover = open && (
    <div className="preview-popover">
      <div className="preview-popover-title">Dev services</div>
      {status.services.length === 0 ? (
        <div className="preview-empty">
          {isStarting ? "Starting up…" : "Not started yet"}
        </div>
      ) : (
        <ul className="preview-services">
          {status.services.map((s) => (
            <li key={s.key}>
              <span className={`preview-dot ${s.running ? "" : "off"}`} />
              <span className="preview-svc-name">{s.name}</span>
              <span className="preview-svc-port">:{s.port}</span>
              <span className={`preview-svc-state ${s.running ? "on" : ""}`}>
                {s.running ? "running" : "stopped"}
              </span>
            </li>
          ))}
        </ul>
      )}
      {running || anyRunning ? (
        <button className="preview-stop" onClick={stop} disabled={!anyRunning || stopping}>
          {stopping ? "Stopping…" : "Stop dev server"}
        </button>
      ) : isStarting ? (
        <button className="preview-stop" onClick={stop} disabled={stopping}>
          {stopping ? "Cancelling…" : "Cancel startup"}
        </button>
      ) : bootable ? (
        <button className="preview-stop" onClick={start}>
          Start dev server
        </button>
      ) : (
        <div className="preview-empty">{notBootableHint}.</div>
      )}
      {variant === "header" && running && (
        <button className="preview-stop preview-snap-row" onClick={snap} disabled={snapping}>
          {snapping ? "Capturing…" : "Snapshot preview"}
        </button>
      )}
      {/* Header mode has no room for a copy segment (single icon by design), so
          the copy action lives here — plus ⌘-click on the icon, mirroring
          StagingLink. The bar layout gets a dedicated segment instead. */}
      {variant === "header" && running && (
        <button
          className="preview-stop preview-copy-row"
          onClick={() => copy(url, { toast: "Preview link copied" })}
        >
          Copy preview link
        </button>
      )}
      <div className="preview-hint">
        {running || anyRunning ? (
          "Stops this worktree's dev process group only."
        ) : bootable ? (
          "Runs the repo's preview boot script in this worktree (first build ~1 min)."
        ) : (
          <a href={PREVIEW_DOCS_URL} target="_blank" rel="noopener">
            Boot-script contract docs
          </a>
        )}
      </div>
    </div>
  );

  // Header mode: a single ▶ icon, color-coded by state (dim=off, amber=starting,
  // green=live), sized to sit next to the panel-toggle icon. Left-click does the
  // primary action; right-click opens the services popover (stop / snapshot).
  // While the server is up (or starting) a small caret rides beside the icon —
  // the popover's stop action was right-click-only and nobody found it
  // (Michiel, 2026-07-09).
  if (variant === "header") {
    const openMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      setOpen((v) => !v);
    };
    const menuCaret = (running || anyRunning || isStarting) && (
      <Tooltip label="Dev services — stop the server, snapshot" side="bottom">
        <button
          className={`viewer-code-icon preview-icon preview-header-caret ${open ? "is-live" : "is-off"}`}
          onClick={openMenu}
          aria-expanded={open}
          aria-label="Dev services"
        >
          <IconChevronDown size={16} />
        </button>
      </Tooltip>
    );
    return (
      <div className="viewer-code-icon-wrap" ref={wrapRef}>
        {running ? (
          <Tooltip
            label={
              copied
                ? "Link copied"
                : "Open the running app — ⌘-click to copy the link, right-click for dev services"
            }
            side="bottom"
          >
            <a
              className="viewer-code-icon preview-icon is-live"
              href={url}
              target="_blank"
              rel="noopener"
              onContextMenu={openMenu}
              onClick={(e) => {
                // ⌘/Ctrl-click copies instead of opening (the same modifier
                // semantics as StagingLink's globe).
                if (e.metaKey || e.ctrlKey) {
                  e.preventDefault();
                  copy(url, { toast: "Preview link copied" });
                }
              }}
            >
              <CopyCheck copied={copied} size={22} idle={<IconPlayOutline size={22} />} />
            </a>
          </Tooltip>
        ) : isStarting ? (
          <Tooltip
            label={stopping ? "Cancelling…" : "Starting the dev server — click to cancel"}
            side="bottom"
          >
            <button
              className="viewer-code-icon preview-icon is-starting"
              onClick={stop}
              onContextMenu={openMenu}
              disabled={stopping}
            >
              <span className="preview-spinner-wrap">
                <span className="preview-spinner" aria-hidden="true" />
                <IconPlayOutline size={22} />
              </span>
            </button>
          </Tooltip>
        ) : !bootable ? (
          <Tooltip label={`${notBootableHint} — right-click for details`} side="bottom" multiline>
            <button
              className="viewer-code-icon preview-icon is-off opacity-45 cursor-not-allowed"
              onClick={openMenu}
              onContextMenu={openMenu}
              aria-disabled="true"
            >
              <IconPlayOutline size={22} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip label="Run — start the dev server (right-click for dev services)" side="bottom">
            <button
              className="viewer-code-icon preview-icon is-off"
              onClick={start}
              onContextMenu={openMenu}
            >
              <IconPlayOutline size={22} />
            </button>
          </Tooltip>
        )}
        {menuCaret}
        {servicesPopover}
        {snapshotModal}
      </div>
    );
  }

  return (
    <div className={`preview-wrap ${running ? "running" : ""}`} ref={wrapRef}>
      {running ? (
        <a
          className="preview-open running"
          href={url}
          target="_blank"
          rel="noopener"
          title={`Open the webapp — ${url}`}
        >
          <IconPlay size={15} className="preview-play" />
          Preview
          <IconArrowUpRight size={15} className="preview-ext" />
        </a>
      ) : isStarting ? (
        <button
          className="preview-open starting"
          onClick={stop}
          disabled={stopping}
          title="Starting the dev server (first build can take a minute) — click to cancel"
        >
          <span className="preview-spinner" />
          <span className="preview-starting-label">
            {stopping ? "Cancelling…" : "Starting…"}
          </span>
          <span className="preview-cancel-label">Cancel</span>
        </button>
      ) : !bootable ? (
        <button
          className="preview-open opacity-45 cursor-not-allowed"
          onClick={() => setOpen((v) => !v)}
          aria-disabled="true"
          title={`${notBootableHint}.`}
        >
          <IconPlay size={15} className="preview-play" />
          Preview
        </button>
      ) : (
        <button
          className="preview-open"
          onClick={start}
          title="Start the dev server and preview this session"
        >
          <IconPlay size={15} className="preview-play" />
          Preview
        </button>
      )}
      {/* Copy segment — the split's secondary action. Enabled once a previewUrl
          exists (server up + Caddy fronting it); before that there's no stable
          URL to hand out, so it sits disabled with a hint. */}
      <button
        className="preview-caret preview-copy aria-disabled:opacity-45 aria-disabled:cursor-default aria-disabled:hover:text-dim aria-disabled:hover:border-line-strong aria-disabled:hover:bg-transparent"
        onClick={() => {
          if (running) copy(url, { toast: "Preview link copied" });
        }}
        aria-disabled={!running || undefined}
        title={running ? `Copy the preview link — ${url}` : "Start the preview first"}
      >
        <CopyCheck copied={copied} size={18} idle={<IconLink size={18} />} />
      </button>
      {running && (
        <button
          className="preview-caret preview-snap"
          onClick={snap}
          disabled={snapping}
          title="Snapshot the preview (headless Chrome screenshot)"
        >
          {snapping ? <span className="preview-spinner" /> : <IconCamera size={18} />}
        </button>
      )}
      <button
        className={`preview-caret preview-menu ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Dev server processes"
        aria-expanded={open}
      >
        <IconChevronDown size={16} />
      </button>

      {snapshotModal}
      {servicesPopover}
    </div>
  );
}
