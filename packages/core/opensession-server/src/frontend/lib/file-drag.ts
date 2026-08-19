/** A DataTransfer has no files to inspect until drop. Its type list is the
 * reliable way to distinguish an OS file drag from links and internal rows. */
export function hasDraggedFiles(
  dataTransfer: Pick<DataTransfer, "types"> | null | undefined,
): boolean {
  return Array.from(dataTransfer?.types ?? []).includes("Files");
}
