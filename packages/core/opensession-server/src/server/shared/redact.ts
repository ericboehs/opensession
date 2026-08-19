/** Strip credentials from https URLs before they reach logs/errors — covers
 *  GitHub's `x-access-token:<token>@` and code.storage's `t:<jwt>@` userinfo
 *  anywhere in the string (git echoes full remote URLs into its stderr). */
export function redactUrl(s: string): string {
  return s.replace(/(https?:\/\/)[^@/\s]+@/g, "$1");
}
