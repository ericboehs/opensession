import { useEffect, useRef, useState } from "react";
import { fetchPreview, stopPreviewApi, type PreviewStatus } from "../lib/api";
import type { UnifiedSession } from "../lib/types";

/**
 * Header control for a session's local dev server. Links to the running webapp
 * (`http://<this-host>:<WEBAPP_PORT>` — reachable over the tailnet because
 * `next dev` binds 0.0.0.0) and, via a popover, shows which dev services are
 * running and lets you stop them. Renders nothing until the worktree has a
 * `.ports.conf` (i.e. `just dev` has run at least once).
 */
export function PreviewButton({ session }: { session: UnifiedSession }) {
  const [status, setStatus] = useState<PreviewStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Poll the dev-server status while this session is open. lsof is cheap and
  // only the active SessionViewer is mounted, so an 8s cadence is plenty.
  useEffect(() => {
    if (!session.worktreeDir) {
      setStatus(null);
      return;
    }
    let alive = true;
    const load = () =>
      fetchPreview(session.id)
        .then((s) => alive && setStatus(s))
        .catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [session.id, session.worktreeDir]);

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (!session.worktreeDir || !status?.hasPortsConf) return null;

  // The webapp is only openable once Caddy has fronted it with an HTTPS origin
  // (previewUrl). A secure origin is required for the app to load fully.
  const running = status.running && status.previewUrl != null;
  const url = status.previewUrl ?? "#";
  const anyRunning = status.services.some((s) => s.running);

  async function stop() {
    setStopping(true);
    try {
      setStatus(await stopPreviewApi(session.id));
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
      ) : (
        <button
          className="preview-open"
          disabled
          title={
            status.running
              ? "Webapp is up but couldn't be exposed over HTTPS (Caddy)"
              : "Webapp isn't running — start it in the session (tella-local)"
          }
        >
          <span className="preview-dot off" />
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
            <div className="preview-empty">No ports configured</div>
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
          <button className="preview-stop" onClick={stop} disabled={!anyRunning || stopping}>
            {stopping ? "Stopping…" : "Stop dev server"}
          </button>
          <div className="preview-hint">Stops this worktree's dev process group only.</div>
        </div>
      )}
    </div>
  );
}
