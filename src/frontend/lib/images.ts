/** Shared helpers for attaching pasted/dropped images to a composer/form. */

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

/** A non-image attachment: kept as name + `data:` URL and staged to disk server-side. */
export interface FileAttachment {
  name: string;
  type: string;
  dataUrl: string;
}

/**
 * Split a picked/dropped file list into images (for the vision path, returned as
 * `data:` URLs) and other files (returned as named attachments the server stages
 * to disk). Images stay on the vision path because Claude can actually see them;
 * everything else is handed to the agent by file path.
 */
export async function splitAttachments(
  files: FileList | File[],
): Promise<{ images: string[]; files: FileAttachment[] }> {
  const all = Array.from(files);
  const imageFiles = all.filter((f) => f.type.startsWith("image/"));
  const otherFiles = all.filter((f) => !f.type.startsWith("image/"));
  const [images, fileUrls] = await Promise.all([
    Promise.all(imageFiles.map(readFileAsDataUrl)),
    Promise.all(otherFiles.map(readFileAsDataUrl)),
  ]);
  return {
    images,
    files: otherFiles.map((f, i) => ({ name: f.name, type: f.type, dataUrl: fileUrls[i] })),
  };
}

/** Image files pulled from a paste event (clipboard), if any. */
export function imageFilesFromPaste(e: React.ClipboardEvent): File[] {
  return Array.from(e.clipboardData?.items || [])
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
}
