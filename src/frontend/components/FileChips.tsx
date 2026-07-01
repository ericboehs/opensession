import React from "react";
import type { FileAttachment } from "../lib/images";

interface Props {
  files: FileAttachment[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}

/** Removable chip row for non-image file attachments (staged to disk server-side). */
export function FileChips({ files, onRemove, disabled }: Props) {
  if (files.length === 0) return null;
  return (
    <div className="composer-files">
      {files.map((f, i) => (
        <div key={i} className="composer-file-chip" title={f.name}>
          <span className="composer-file-icon">📎</span>
          <span className="composer-file-name">{f.name}</span>
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
