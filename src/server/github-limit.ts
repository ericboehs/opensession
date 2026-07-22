/**
 * Shared GitHub rate-limit gate.
 *
 * Every server-side GitHub caller (gh CLI spawns and direct api.github.com
 * fetches) reports rate-limit failures here and consults the gate before
 * firing, so one exhausted quota pauses ALL pollers together instead of each
 * one independently burning doomed calls into the same bot account's window.
 * Callers with cached data keep serving their stale snapshot for the duration;
 * callers without any answer fast with a friendly error instead of spawning gh.
 *
 * State parks on globalThis so a `bun --hot` reload keeps an active backoff
 * window instead of resetting it and re-firing everything at once.
 */

interface GhLimitState {
  /** Epoch ms until which GitHub calls should not be attempted. 0 = clear. */
  backoffUntil: number;
  probe: Promise<void> | null;
  /** Cached `gh auth token` output for direct REST calls (null = probed, none). */
  botToken: string | null | undefined;
}

const state: GhLimitState = ((globalThis as any).__osGhLimitState ||= {
  backoffUntil: 0,
  probe: null,
  botToken: undefined,
});

export function ghRateLimited(): boolean {
  return Date.now() < state.backoffUntil;
}

/** Epoch ms the current backoff ends, or 0 when no backoff is active. */
export function ghBackoffUntil(): number {
  return ghRateLimited() ? state.backoffUntil : 0;
}

/** True when a gh CLI / API error message is a rate-limit rejection. */
export function isGhRateLimitMsg(msg: string): boolean {
  return /rate limit|secondary limit|abuse detection/i.test(msg);
}

/**
 * Record that GitHub rejected a call for rate limiting. When the caller knows
 * the reset time (REST's x-ratelimit-reset header), it passes it; otherwise we
 * probe `gh api rate_limit` for the GraphQL reset — rate_limit itself is REST
 * (core quota), so it usually still answers when GraphQL, which nearly all of
 * our polling runs on, is exhausted. A 15-minute fallback covers the probe
 * failing too (core quota can be gone as well).
 */
export function noteGhRateLimited(source: string, resetEpochMs?: number): void {
  if (resetEpochMs && resetEpochMs > Date.now()) {
    // Cap at 2h in case a caller feeds us a bogus far-future reset.
    const until = Math.min(resetEpochMs + 30_000, Date.now() + 2 * 3600_000);
    if (until > state.backoffUntil) {
      state.backoffUntil = until;
      console.error(
        `[github-limit] ${source}: rate-limited; pausing GitHub calls until ${new Date(until).toISOString()}`,
      );
    }
    return;
  }
  if (ghRateLimited() || state.probe) return;
  // Fallback first, in case the probe below fails.
  state.backoffUntil = Date.now() + 15 * 60_000;
  state.probe = (async () => {
    try {
      const proc = Bun.spawn(
        ["gh", "api", "rate_limit", "--jq", ".resources.graphql.reset"],
        { stdout: "pipe", stderr: "ignore" },
      );
      const raw = await new Response(proc.stdout).text();
      if ((await proc.exited) === 0) {
        const reset = parseInt(raw.trim(), 10) * 1000;
        if (reset > Date.now()) state.backoffUntil = reset + 30_000;
      }
    } catch {}
    console.error(
      `[github-limit] ${source}: rate-limited; pausing GitHub calls until ${new Date(state.backoffUntil).toISOString()}`,
    );
    state.probe = null;
  })();
}

/**
 * Token for direct api.github.com calls made on the bot's behalf (conditional
 * change probes and the like): the GITHUB_API_TOKEN PAT when configured, else
 * the gh CLI's own token, probed once and cached for the process lifetime.
 */
export async function botGhToken(): Promise<string | null> {
  if (process.env.GITHUB_API_TOKEN) return process.env.GITHUB_API_TOKEN;
  if (state.botToken !== undefined) return state.botToken;
  try {
    const proc = Bun.spawn(["gh", "auth", "token"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const raw = await new Response(proc.stdout).text();
    state.botToken = (await proc.exited) === 0 && raw.trim() ? raw.trim() : null;
  } catch {
    state.botToken = null;
  }
  return state.botToken;
}
