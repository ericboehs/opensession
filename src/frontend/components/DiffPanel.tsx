import React, { useEffect, useState, useCallback } from "react";
import { PatchDiff } from "@pierre/diffs/react";
import type { SessionDiff } from "../lib/types";
import { fetchDiff } from "../lib/api";

interface Props {
  sessionId: string;
  isRunning: boolean;
}

const DIFF_OPTIONS = {
  theme: "pierre-dark",
  themeType: "dark" as const,
  diffStyle: "unified" as const,
  stickyHeader: true,
  overflow: "scroll" as const,
};

export function DiffPanel({ sessionId, isRunning }: Props) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchDiff(sessionId);
      if (data.error) throw new Error(data.error);
      setDiff(data);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    load();
    // Keep the diff fresh while the agent is working
    const interval = setInterval(load, isRunning ? 8000 : 30000);
    return () => clearInterval(interval);
  }, [load, isRunning]);

  if (loading) return <div className="panel-placeholder">Loading diff…</div>;
  if (error) return <div className="panel-placeholder panel-error">{error}</div>;
  if (!diff || (!diff.rawPatch.trim() && diff.files.length === 0)) {
    return <div className="panel-placeholder">No changes yet</div>;
  }

  return (
    <div className="diff-panel">
      <div className="diff-summary">
        <span className="diff-summary-files">
          {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed
        </span>
        <span className="diff-add">+{diff.totalAdditions}</span>
        <span className="diff-del">−{diff.totalDeletions}</span>
        {diff.truncated && <span className="diff-truncated">truncated</span>}
        <button className="btn-icon" onClick={load} title="Refresh diff">↻</button>
      </div>

      <div className="diff-render">
        <PatchDiff patch={diff.rawPatch} options={DIFF_OPTIONS} disableWorkerPool />
      </div>
    </div>
  );
}
