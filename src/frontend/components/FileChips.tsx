import React from "react";
import type { FileAttachment } from "../lib/images";

interface Props {
  files: FileAttachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}

/** Short uppercase extension badge for a filename (e.g. "PDF", "TS"), or "FILE". */
function extBadge(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "FILE";
  return name.slice(dot + 1, dot + 5).toUpperCase();
}

/** Removable preview cards for non-image file attachments (staged to disk server-side). */
export function FileChips({ files, onRemove, disabled }: Props) {
  if (files.length === 0) return null;
  return (
    <div className="composer-files">
      {files.map((f, i) => (
        <div key={i} className="composer-file-card" title={f.name}>
          <span className="composer-file-thumb">{extBadge(f.name)}</span>
          <span className="composer-file-meta">
            <span className="composer-file-name">{f.name}</span>
            <span className="composer-file-sub">Attachment</span>
          </span>
          <button
            type="button"
            className="composer-file-remove"
            onClick={() => onRemove(i)}
            disabled={disabled}
            title="Remove file"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
