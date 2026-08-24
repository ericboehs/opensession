/** Branch names are embedded in generated Markdown and shell instructions in
 * addition to argv-safe Git calls. This subset cannot terminate either form. */
const SHELL_SAFE_BRANCH_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellSafeDefaultBranch(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const branch = value.trim();
  return branch && SHELL_SAFE_BRANCH_RE.test(branch) ? branch : undefined;
}
