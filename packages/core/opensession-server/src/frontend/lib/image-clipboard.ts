/** Convert any browser-readable image to PNG for the async Clipboard API.
 * Safari accepts PNG consistently, while JPEG and WebP support varies. */
async function imagePng(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error(`Image load failed: ${response.status}`);
  const source = await response.blob();
  if (source.type === "image/png") return source;

  const bitmap = await createImageBitmap(source);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image canvas is unavailable");
    context.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob ? resolve(blob) : reject(new Error("Image conversion failed")),
        "image/png",
      );
    });
  } finally {
    bitmap.close();
  }
}

/** Copy an image while preserving Safari's transient user activation. The
 * pending blob is handed to ClipboardItem synchronously, before fetch awaits. */
export function copyImageToClipboard(src: string): Promise<void> {
  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    return Promise.reject(new Error("Image copy is unavailable"));
  }
  const png = imagePng(src);
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
