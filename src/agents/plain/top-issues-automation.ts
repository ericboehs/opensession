/**
 * "Plain Top Issues rollup" — code-seeded automation (create-if-absent).
 *
 * Weekday 14:00 UTC (~4pm Amsterdam): a Haiku agent runs the deterministic
 * top-issues helper, then for each shown issue PICKS the nicest genuine customer
 * quote from the raw candidates (Haiku judgment, not regex), and posts one rollup
 * to #chat — but only if there are new links since the previous run.
 */
import { listAutomations, createAutomation } from "../../server/automations";

const EVENT_KEY = "cron:plain-top-issues";
const CHAT = "C01ED50A2KG"; // #chat
const HELPER = "/home/ubuntu/projects/tella-backstage/src/agents/plain/top-issues.ts";

const PROMPT = `You are Michael, posting the daily "Plain Top Issues" rollup to the team in Slack channel \`${CHAT}\` (#chat).

Permissions: read-only except the one Slack post via the MCP, which is the purpose of this run — don't refuse it.

## 1. Get the data
Run: \`bun ${HELPER}\` (Bash). It prints JSON: { shouldPost, totalNewLinks, windowLabel, top3[], movers[] }. Each issue has: title, url (Linear), totalLinks, newLinks, and quoteCandidates (raw inbound customer texts from linked threads).

## 2. If shouldPost is false, STOP
Post nothing (no new customer links since the last rollup). End quietly.

## 3. Pick ONE genuine customer quote per issue (your judgment)
For each issue you'll show, choose the single best quote from its quoteCandidates:
- It must be the CUSTOMER's own words asking for / describing THIS feature (match the issue title).
- IGNORE: auto-replies ("Thanks for reaching out…", "normal support hours"), CSAT/survey emails ("we'd love your feedback"), support/agent messages, quoted email reply chains and signatures, and anything off-topic.
- Trim to one clean sentence or two (~max 220 chars), fix obvious typos lightly, keep the customer's voice. Do not invent words.
- If NONE of the candidates is a clean on-topic customer quote, omit the quote for that issue (write "_(newly linked — no clean customer quote yet)_") rather than forcing one.

## 4. Post ONE message to ${CHAT}
Format (Slack mrkdwn), concise and skimmable:
\`:bar_chart: *Plain Top Issues — daily rollup*  ·  _<N> new customer links since <windowLabel>_\`
then a one-line intro that it's you, Michael.
Section \`:trophy: *Top 3 most-requested*\`: numbered list, each \`*<url|Issue name>*  ·  <totalLinks> linked tickets\` then the quote on the next line as a blockquote (\`> "…"\`). Use a short issue name (strip any ": …" suffix from the title).
Section \`:chart_with_upwards_trend: *Got new links since the last rollup*\`: the movers as bullets, each \`• *<url|Issue name>*  ·  <totalLinks> linked · +<newLinks> new\` then its quote blockquote (or the no-quote note).
Post it with the Slack MCP \`conversations_add_message\` to channel \`${CHAT}\`. Post exactly once.`;

export function ensureTopIssuesRollup(): void {
  if (listAutomations().some((a) => a.eventKey === EVENT_KEY)) return;
  const created = createAutomation({
    name: "Plain Top Issues rollup",
    prompt: PROMPT,
    schedule: "0 14 * * 1-5", // ~4pm Amsterdam every weekday (drifts 1h with DST, like the other team crons)
    mode: "ask",
    createdBy: "Michael (plain agent)",
    eventKey: EVENT_KEY,
    mcpServers: ["slack"],
    model: "claude-haiku-4-5",
  });
  if ("error" in created) {
    console.error(`[plain] Failed to seed Top Issues rollup:`, created.error);
  } else {
    console.log(`[plain] Seeded "Plain Top Issues rollup" automation (${created.id})`);
  }
}
