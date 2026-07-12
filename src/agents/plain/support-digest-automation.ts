/**
 * "Morning support digest" — code-seeded automation (create-if-absent).
 *
 * Daily 06:00 UTC (8am Amsterdam in summer, 7am in winter — cron is UTC, so
 * it drifts 1h with DST like the Top Issues rollup). A Fable orchestrator
 * reads the Plain queue, fans the per-ticket analysis out to CHEAP models via
 * one opensession-workflows run (the automation carries the human-set
 * `workflows` flag), and publishes one self-contained HTML report via
 * opensession-report — surfaced in the frontend Reports view and linked from
 * the sidebar's Support band.
 */
import { listAutomations, createAutomation } from "../../server/automations";

const EVENT_KEY = "cron:plain-support-digest";
export const SUPPORT_DIGEST_NAME = "Morning support digest";

const PROMPT = `You are Michael. Produce the morning support digest: one scannable HTML report of the Plain support queue, so the team starts the day with a bounded plan instead of a wall of tickets.

Step 1 — gather (plain MCP, reads only): get_queue_stats; list_threads status "todo" limit 100 (rows include labels); list_threads status "snoozed" limit 100 for its count. Compute the deterministic facts yourself or inside the workflow script — counts, new-in-last-24h (createdAt), per-label breakdown plus unlabeled count, the 5 oldest with ages — never spend agent tokens on arithmetic.

Step 2 — analyze with ONE run_workflow call, token-efficiently. You are the expensive orchestrator; the fan-out must run on cheap models. Pass the todo rows via args_json. In the script: chunk the threads (~15 per chunk) and run the chunks in parallel, one agent per chunk on model "claude-haiku-4-5" with a JSON schema, extracting candidate clusters (tickets that look like the same underlying issue), quick wins (simple how-to/billing questions answerable in minutes), and anything urgent-looking. Then ONE synthesis agent on "claude-sonnet-5" merges the chunk outputs into: possible incidents (clusters of 3+ with thread ids), quick wins, and a "start here" plan (max 10 ordered items — incidents first, then quick wins, then the oldest tickets). Do not run any workflow agent on fable or opus, and keep the total fan-out under ~10 agents.

Step 3 — if the synthesis found incident clusters, briefly search Linear (linear MCP) for matching OPEN issues and include identifier + url; skip this entirely when there are no clusters.

Step 4 — publish: render ONE self-contained HTML document (inline CSS only, no external resources, no JS; compact, dark-background friendly) titled "Support digest — <YYYY-MM-DD>". Sections in order: headline numbers (todo, snoozed, new in 24h, oldest age); Start here; Possible incidents; Per-label breakdown (small table); Oldest tickets. Every ticket you mention must link to https://os.tella.dev/support/<threadId> (the OpenSession ticket preview). Publish it with opensession-report's publish_report — title, the full HTML, and a 1-2 sentence summary with the counts and the top action.

Finish your reply with a 3-5 line text summary: headline counts and the top 2 recommended actions.

Hard rules: read-only towards Plain — never reply to a customer, never change thread status/priority/assignee/labels, never write Plain notes. One workflow run, one published report per run.`;

export function ensureSupportDigestAutomation(): void {
  if (listAutomations().some((a) => a.eventKey === EVENT_KEY)) return;
  const created = createAutomation({
    name: SUPPORT_DIGEST_NAME,
    prompt: PROMPT,
    schedule: "0 6 * * *", // ~8am Amsterdam (drifts 1h with DST; cron is UTC)
    mode: "ask",
    createdBy: "Michael (plain agent)",
    eventKey: EVENT_KEY,
    mcpServers: ["plain", "linear"],
    workflows: true, // human-set: cron prompt is our own text (see workflow-tools.ts)
    model: "claude-fable-5",
    fallbackModel: "gpt-5.6-sol", // Michiel: fall back to Sol if Fable is unavailable
  });
  if ("error" in created) {
    console.error(`[plain] Failed to seed Morning support digest:`, created.error);
  } else {
    console.log(`[plain] Seeded "${SUPPORT_DIGEST_NAME}" automation (${created.id})`);
  }
}
