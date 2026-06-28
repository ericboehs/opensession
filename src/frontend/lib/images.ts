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

/** Image files pulled from a paste event (clipboard), if any. */
export function imageFilesFromPaste(e: React.ClipboardEvent): File[] {
  return Array.from(e.clipboardData?.items || [])
    .filter((it) => it.kind === "file" && it.type.startsWith("image/"))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f);
}
