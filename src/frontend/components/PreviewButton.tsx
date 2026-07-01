import { useEffect, useRef, useState } from "react";
import {
  fetchPreview,
  startPreviewApi,
  stopPreviewApi,
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
export function PreviewButton({ session }: { session: UnifiedSession }) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
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
          disabled
          title="Starting Tella Local — this can take a minute on first build"
        >
          <span className="preview-spinner" />
          Starting…
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
      <button
        className={`preview-caret ${open ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title="Dev server processes"
        aria-expanded={open}
      >
        ▾
      </button>

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
          ) : (
            <button className="preview-stop" onClick={start} disabled={isStarting}>
              {isStarting ? "Starting…" : "Start dev server"}
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
