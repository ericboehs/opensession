import { useEffect, useRef, useState } from "react";
import {
  fetchPreview,
  startPreviewApi,
  stopPreviewApi,
  capturePreviewShot,
  type PreviewStatus,
} from "../lib/api";
import type { UnifiedSession } from "../lib/types";

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
}: {
  session: UnifiedSession;
  /** When set, the snapshot modal offers "Attach to chat" (stages the PNG as a
   *  composer image, like a paste). */
  onAttachImage?: (dataUrl: string) => void;
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
  const url = status.previewUrl ?? "#";
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

  return (
    <div className="preview-wrap" ref={wrapRef}>
      {running ? (
        <a
          className="preview-open running"
          href={url}
          target="_blank"
          rel="noopener"
          title={`Open the webapp — ${url}`}
        >
          <span className="preview-dot" />
          Preview ↗
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
          <span className="preview-play" aria-hidden="true">
            ▶
          </span>
          Preview
        </button>
      )}
      {running && (
        <button
          className="preview-caret"
          onClick={async () => {
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
          }}
          disabled={snapping}
          title="Snapshot the preview (headless Chrome screenshot)"
        >
          {snapping ? (
            <span className="preview-spinner" />
          ) : (
            <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2.5 5.5h2l1.2-1.8h4.6L11.5 5.5h2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" strokeLinejoin="round" />
              <circle cx="8" cy="9" r="2.4" />
            </svg>
          )}
        </button>
      )}
      <button
        className={`preview-caret ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Dev server processes"
        aria-expanded={open}
      >
        ▾
      </button>

      {(shot || shotError) && (
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
      )}

      {open && (
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
          <div className="preview-hint">
            {running || anyRunning
              ? "Stops this worktree's dev process group only."
              : "Runs just dev in this worktree (first build ~1 min)."}
          </div>
        </div>
      )}
    </div>
  );
}
