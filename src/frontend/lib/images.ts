/** Shared helpers for attaching pasted/dropped images to a composer/form. */

import { BASE_PATH } from "./base";

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export async function filesToDataUrls(files: FileList | File[]): Promise<string[]> {
  const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
  return Promise.all(imgs.map(readFileAsDataUrl));
}

/**
 * A non-image attachment. Big files are streamed to disk over the HTTP upload
 * endpoint and carry the server's staged `path` (what the next turn sends);
 * `dataUrl` is only kept as a fallback for tiny inline cases / older paths.
 */
export interface FileAttachment {
  name: string;
  type: string;
  path?: string;
  dataUrl?: string;
}

// Mirror of the server's MAX_UPLOAD_BYTES (backstage.ts). Enforced client-side too
// so an oversized file fails loudly at pick time instead of silently vanishing.
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Stream one file to the server upload endpoint; resolves to its staged path. */
export async function uploadFile(file: File): Promise<{ name: string; path: string }> {
  const res = await fetch(`${BASE_PATH}/api/upload`, {
    method: "POST",
    headers: {
      "x-file-name": encodeURIComponent(file.name),
      "content-type": file.type || "application/octet-stream",
    },
    body: file,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body?.ok || !body?.path) {
    throw new Error(body?.error || `Upload failed (${res.status})`);
  }
  return { name: body.name || file.name, path: body.path };
}

/**
 * Split a picked/dropped file list into images (for the vision path, returned as
 * `data:` URLs) and other files (streamed to disk via the HTTP upload endpoint and
 * returned as name+path refs). Images stay on the vision path because Claude can
 * actually see them; everything else is handed to the agent by file path.
 * `rejected` lists files that were too big or failed to upload, so the caller can
 * surface them instead of dropping them silently.
 */
export async function splitAttachments(
  files: FileList | File[],
): Promise<{ images: string[]; files: FileAttachment[]; rejected: string[] }> {
  const all = Array.from(files);
  const imageFiles = all.filter((f) => f.type.startsWith("image/"));
  const otherFiles = all.filter((f) => !f.type.startsWith("image/"));
  const images = await Promise.all(imageFiles.map(readFileAsDataUrl));

  const rejected: string[] = [];
  const uploaded = await Promise.all(
    otherFiles.map(async (f): Promise<FileAttachment | null> => {
      if (f.size > MAX_UPLOAD_BYTES) {
        rejected.push(`${f.name} (too large — max ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB)`);
        return null;
      }
      try {
        const { name, path } = await uploadFile(f);
        return { name, type: f.type, path };
      } catch (e) {
        rejected.push(`${f.name} (${(e as Error)?.message || "upload failed"})`);
        return null;
      }
    }),
  );

  return {
    images,
    files: uploaded.filter((f): f is FileAttachment => f !== null),
    rejected,
  };
}

/** Image files pulled from a paste event (clipboard), if any. */
export function imageFilesFromPaste(e: React.ClipboardEvent): File[] {
  return Array.from(e.clipboardData?.items || [])
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
}
