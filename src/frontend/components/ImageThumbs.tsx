import React from "react";
import { openLightbox } from "./MediaLightbox";

interface Props {
  /** Attached images as `data:` URLs. */
  images: string[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}

/** Removable thumbnail row for pasted/dropped image attachments. */
export function ImageThumbs({ images, onRemove, disabled }: Props) {
  if (images.length === 0) return null;
  return (
    <div className="composer-images">
      {images.map((src, i) => (
        <div key={i} className="composer-image-thumb">
          <button
            type="button"
            className="composer-image-preview"
            onClick={(event) =>
              openLightbox(
                images.map((image) => ({ kind: "image", src: image })),
                i,
                event.currentTarget,
              )
            }
            aria-label="Open image preview"
          >
            <img src={src} alt="" />
          </button>
          <button
            type="button"
            className="composer-image-remove"
            onClick={() => onRemove(i)}
            disabled={disabled}
            title="Remove image"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
