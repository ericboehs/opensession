/** Empty check rollups are transient just after GitHub exposes a pushed head. */
export function checkRegistrationPending(
  checkCount: number,
  matchingHeadSeenAt: number,
  now: number,
  graceMs: number,
): boolean {
  return checkCount === 0 && now - matchingHeadSeenAt < graceMs;
}
