/** A DataTransfer has no files to inspect until drop. Its type list is the
 * reliable way to distinguish an OS file drag from links and internal rows. */
export function hasDraggedFiles(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}

export const GLOBAL_FILE_COMPOSER_ATTR = "data-global-file-composer";

type FileComposerCandidate = { getClientRects(): { length: number } };

function visibleFileComposers(
  candidates?: Iterable<FileComposerCandidate>,
): FileComposerCandidate[] {
  const nodes =
    candidates ??
    (typeof document === "undefined"
      ? []
      : document.querySelectorAll<HTMLElement>(
          `[${GLOBAL_FILE_COMPOSER_ATTR}]`,
        ));
  return Array.from(nodes).filter((node) => node.getClientRects().length > 0);
}

/** Whether a visible foreground composer owns the app-wide file drop. Hidden,
 * kept-mounted surfaces have no client rects and cannot steal the active drop. */
export function foregroundFileComposerOpen(
  candidates?: Iterable<FileComposerCandidate>,
): boolean {
  return visibleFileComposers(candidates).length > 0;
}

/** Whether this is the topmost visible foreground composer. Foreground
 * composers are portals mounted in visual order, so the last visible marker
 * owns the drag when two overlays are open at once. */
export function foregroundFileComposerOwns(
  candidate: FileComposerCandidate | null,
  candidates?: Iterable<FileComposerCandidate>,
): boolean {
  if (!candidate) return false;
  const visible = visibleFileComposers(candidates);
  return visible[visible.length - 1] === candidate;
}
