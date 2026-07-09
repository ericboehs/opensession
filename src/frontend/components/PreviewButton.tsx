import { useEffect, useRef, useState } from "react";
import {
  fetchPreview,
  startPreviewApi,
  stopPreviewApi,
  capturePreviewShot,
  type PreviewStatus,
} from "../lib/api";
import type { UnifiedSession } from "../lib/types";
import { withPreviewPath } from "../lib/preview-url";
import { Tooltip } from "../ui/tooltip";
import {
  IconArrowUpRight,
  IconCamera,
  IconChevronDown,
  IconPlay,
  IconPlayOutline,
} from "./icons";

// Only tella-fusion worktrees are previewable — the bring-up script
// (tella-local ensure-up.sh) seeds a tella-fusion webapp specifically.
function isPreviewable(session: UnifiedSession): boolean {
  if (!session.worktreeDir) return false;
  return (session.repo ?? "tella-fusion") === "tella-fusion";
}

/**
 * Header control for a session's local dev server ("Tella Local"). When the
 * webapp is up it links to it (`https://<host>:<httpsPort>` — a Caddy-fronted
 * secure origin over the tailnet); when it's off, a ▶ play button starts it
 * (runs `just dev` in the worktree via the tella-local script), showing a
 * "Starting…" state until the server is listening. A caret popover lists the
 * dev services and can stop them. Renders only for tella-fusion worktrees.
 */
export function PreviewButton({
  session,
  onAttachImage,
  variant = "bar",
}: {
  session: UnifiedSession;
  /** When set, the snapshot modal offers "Attach to chat" (stages the PNG as a
   *  composer image, like a paste). */
  onAttachImage?: (dataUrl: string) => void;
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

  const previewable = isPreviewable(session);

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

  async function start() {
    setStarting(true);
    try {
      setStatus(await startPreviewApi(session.id));
    } catch {
      setStarting(false);
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
      ) : (
        <button className="preview-stop" onClick={start}>
          Start dev server
        </button>
      )}
      {variant === "header" && running && (
        <button className="preview-stop preview-snap-row" onClick={snap} disabled={snapping}>
          {snapping ? "Capturing…" : "Snapshot preview"}
        </button>
      )}
      <div className="preview-hint">
        {running || anyRunning
          ? "Stops this worktree's dev process group only."
          : "Runs just dev in this worktree (first build ~1 min)."}
      </div>
    </div>
  );

  // Header mode: a single ▶ icon, color-coded by state (dim=off, amber=starting,
  // green=live), sized to sit next to the panel-toggle icon. Left-click does the
  // primary action; right-click opens the services popover (stop / snapshot).
  if (variant === "header") {
    const openMenu = (e: React.MouseEvent) => {
      e.preventDefault();
      setOpen((v) => !v);
    };
    return (
      <div className="viewer-code-icon-wrap" ref={wrapRef}>
        {running ? (
          <Tooltip label="Open the running app — right-click for dev services" side="bottom">
            <a
              className="viewer-code-icon preview-icon is-live"
              href={url}
              target="_blank"
              rel="noopener"
              onContextMenu={openMenu}
            >
              <IconPlayOutline size={24} />
            </a>
          </Tooltip>
        ) : isStarting ? (
          <Tooltip
            label={stopping ? "Cancelling…" : "Starting Tella Local — click to cancel"}
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
                <IconPlayOutline size={24} />
              </span>
            </button>
          </Tooltip>
        ) : (
          <Tooltip label="Run — start Tella Local (right-click for dev services)" side="bottom">
            <button
              className="viewer-code-icon preview-icon is-off"
              onClick={start}
              onContextMenu={openMenu}
            >
              <IconPlayOutline size={24} />
            </button>
          </Tooltip>
        )}
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
          title="Starting Tella Local (first build can take a minute) — click to cancel"
        >
          <span className="preview-spinner" />
          <span className="preview-starting-label">
            {stopping ? "Cancelling…" : "Starting…"}
          </span>
          <span className="preview-cancel-label">Cancel</span>
        </button>
      ) : (
        <button
          className="preview-open"
          onClick={start}
          title="Start Tella Local and preview this session"
        >
          <IconPlay size={15} className="preview-play" />
          Preview
        </button>
      )}
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
