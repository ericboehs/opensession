import React, { useEffect, useState, useCallback } from "react";
import type { SessionDiff, DiffFile } from "../lib/types";
import { fetchDiff } from "../lib/api";

interface Props {
  sessionId: string;
  isRunning: boolean;
}

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "A",
  untracked: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
};

export function DiffPanel({ sessionId, isRunning }: Props) {
  const [diff, setDiff] = useState<SessionDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

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

  function toggleFile(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (loading) return <div className="panel-placeholder">Loading diff…</div>;
  if (error) return <div className="panel-placeholder panel-error">{error}</div>;
  if (!diff || diff.files.length === 0) {
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
        <button className="btn-icon" onClick={load} title="Refresh diff">↻</button>
      </div>

      <div className="diff-files">
        {diff.files.map((file) => (
          <div key={file.path} className="diff-file">
            <button className="diff-file-header" onClick={() => toggleFile(file.path)}>
              <span className={`diff-status diff-status-${file.status}`}>
                {STATUS_LABEL[file.status]}
              </span>
              <span className="diff-file-path">
                {file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
              </span>
              <span className="diff-file-stats">
                {file.additions > 0 && <span className="diff-add">+{file.additions}</span>}
                {file.deletions > 0 && <span className="diff-del">−{file.deletions}</span>}
              </span>
              <span className="diff-chevron">{collapsed.has(file.path) ? "▸" : "▾"}</span>
            </button>
            {!collapsed.has(file.path) && (
              <pre className="diff-patch">
                {file.patch.split("\n").map((line, i) => (
                  <div key={i} className={`diff-line ${lineClass(line)}`}>
                    {line || " "}
                  </div>
                ))}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("+")) return "diff-line-add";
  if (line.startsWith("-")) return "diff-line-del";
  if (line.startsWith("@@")) return "diff-line-hunk";
  return "";
}
