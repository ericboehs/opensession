/** Lightweight, credential-safe GitHub API budget telemetry. */
import { githubToken } from "./github-app";

type Sample = { calls: number; failures: number; durationMs: number };
const samples = new Map<string, Sample>();
let lastLogAt = 0;
let probe: Promise<void> | null = null;

/**
 * Count a GraphQL consumer and periodically snapshot the installation bucket.
 * Logs consumer labels, aggregate timings, and numeric quota only. Tokens,
 * query variables, repository data, and response bodies are never logged.
 */
export function noteGithubGraphqlCall(
  consumer: string,
  durationMs: number,
  ok: boolean,
  opts: { ambient?: boolean } = {},
): void {
  const key = `${opts.ambient ? "ambient" : "service"}:${consumer}`;
  const sample = samples.get(key) || { calls: 0, failures: 0, durationMs: 0 };
  sample.calls++;
  sample.durationMs += Math.max(0, durationMs);
  if (!ok) sample.failures++;
  samples.set(key, sample);
  if (Date.now() - lastLogAt < 60_000 || probe) return;
  lastLogAt = Date.now();
  probe = (async () => {
    let budget = "budget=unavailable";
    try {
      const token = await githubToken();
      if (token) {
        const response = await fetch("https://api.github.com/rate_limit", {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "opensession-budget",
          },
          signal: AbortSignal.timeout(10_000),
        });
        const json = (await response.json().catch(() => null)) as any;
        const gql = json?.resources?.graphql;
        if (response.ok && gql)
          budget = `remaining=${gql.remaining}/${gql.limit} used=${gql.used} reset=${new Date(Number(gql.reset) * 1000).toISOString()}`;
      }
    } catch {}
    const totals = [...samples.entries()]
      .map(
        ([label, value]) =>
          `${label}{calls=${value.calls},failures=${value.failures},durationMs=${Math.round(value.durationMs)}}`,
      )
      .join(" ");
    console.log(
      `[github-budget] graphql credential=app ${budget} consumers=${totals || "none"}`,
    );
    samples.clear();
    probe = null;
  })();
}
