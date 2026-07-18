/**
 * "Plain Top Issues rollup" — code-seeded automation (create-if-absent).
 *
 * Tue & Thu 14:00 UTC (~4pm Amsterdam): a Haiku agent runs the deterministic
 * top-issues helper, then for each shown issue PICKS the nicest genuine customer
 * quote from the raw candidates (Haiku judgment, not regex), and posts one rollup
 * to #chat — but only if there are new links since the previous run.
 */
import { personaName } from "../../server/config";
import { listAutomations, createAutomation } from "../../server/automations";

const EVENT_KEY = "cron:plain-top-issues";
const CHAT = "C01ED50A2KG"; // #chat
const HELPER = "/home/ubuntu/projects/tella-backstage/src/agents/plain/top-issues.ts";

const PROMPT = `You are Michael. Post the twice-weekly "Plain Top Issues" rollup to #chat.

Run this once via Bash: \`bun ${HELPER} --post\`

That command does everything deterministically: it pulls Plain's Top Issues (ranked Linear issues by linked tickets), finds which got new links since the last run, picks the nicest genuine customer quote per issue with Haiku, and posts the rollup to ${CHAT} (#chat) with link-unfurling disabled — but ONLY if there are new links (otherwise it posts nothing). It prints one line summarizing what it did.

Report that line back. Do not post anything yourself or take any other action.`;

export function ensureTopIssuesRollup(): void {
  if (listAutomations().some((a) => a.eventKey === EVENT_KEY)) return;
  const created = createAutomation({
    name: "Plain Top Issues rollup",
    prompt: PROMPT,
    schedule: "0 14 * * 2,4", // Tue & Thu ~4pm Amsterdam (drifts 1h with DST); keep in sync with RUN_DAYS in top-issues.ts
    mode: "ask",
    createdBy: `${personaName()} (plain agent)`,
    eventKey: EVENT_KEY,
    mcpServers: [], // the helper posts to Slack itself (chat.postMessage, unfurl off)
    model: "claude-haiku-4-5",
  });
  if ("error" in created) {
    console.error(`[plain] Failed to seed Top Issues rollup:`, created.error);
  } else {
    console.log(`[plain] Seeded "Plain Top Issues rollup" automation (${created.id})`);
  }
}
