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
import { personaName } from "../../server/config";
import { listAutomations, createAutomation } from "../../server/automations";

const EVENT_KEY = "cron:plain-support-digest";
export const SUPPORT_DIGEST_NAME = "Morning support digest";

export const SUPPORT_DIGEST_PROMPT = `You are Michael. Produce the morning support digest: one scannable HTML report of the Plain support queue that lets the team work THROUGH the queue from the report alone — a bounded plan up top, then a complete categorized listing. Completeness matters: every todo ticket must appear exactly once in the report (in Easy tickets, a cluster, or Remaining), so nothing has to be re-triaged in Plain.

Step 1 — gather (plain MCP, reads only): get_queue_stats; list_threads status "todo" limit 100 (rows include labels); list_threads status "snoozed" limit 100 for its count. Compute the deterministic facts yourself or inside the workflow script — counts, new-in-last-24h (createdAt), per-label breakdown plus unlabeled count, the 5 oldest with ages — never spend agent tokens on arithmetic.

Step 2 — analyze with ONE run_workflow call, token-efficiently. You are the expensive orchestrator; the fan-out must run on cheap models. You have NO shell/bash in this run (ask mode denies it — don't try, don't stage data in temp files); all data prep happens in the workflow script itself. Pass the todo rows via args_json. In the script: chunk the threads (~15 per chunk) and run the chunks in parallel, one agent per chunk on model "claude-haiku-4-5" with a JSON schema that classifies EVERY ticket in the chunk: {id, title, difficulty: "easy"|"medium"|"hard", category (short, e.g. "billing", "export", "how-to"), action (ONE imperative sentence — the concrete next step or the gist of the reply to send), urgent (boolean), cluster_hint (short slug when it looks like a shared underlying issue, else null)}. "easy" means a teammate could close it in ~5 minutes: how-to/where-is questions, standard billing ops (cancel, refund, invoice fix), duplicate reports, simple acknowledgements. Then ONE synthesis agent on "claude-sonnet-5" merges the chunk outputs into: possible incidents (clusters of 3+ with thread ids), the complete easy list (every easy ticket passed through with its action — never sampled or capped), and a "start here" plan (max 10 ordered items — incidents first, then urgent items, then the oldest tickets). Do not run any workflow agent on fable or opus, and keep the total fan-out under ~10 agents.

Step 3 — if the synthesis found incident clusters, briefly search Linear (linear MCP) for matching OPEN issues and include identifier + url; skip this entirely when there are no clusters.

Step 4 — publish: render ONE self-contained HTML document (inline CSS only, no external resources, no JS; compact, dark-background friendly) titled "Support digest — <YYYY-MM-DD>". Sections in order:
1. Headline numbers: todo, snoozed, new in 24h, oldest age, and the easy count.
2. Start here — the bounded plan (max 10 ordered items).
3. Easy tickets — the queue-burner list: EVERY easy-classified ticket, one row each with linked title, age, labels, and its one-line suggested action. Do not cap or sample this section — it's how the team clears volume fast, so completeness beats brevity.
4. Possible incidents — clusters with linked thread titles and any matching open Linear issues.
5. Remaining tickets — every todo ticket not already listed above, grouped by category, one compact row each (linked title, age, one-line action when the classification has a useful one).
6. Per-label breakdown (small table).
7. Oldest tickets.
Every ticket mention must use this exact HTML shape (substitute the real id and escaped title): \`<a href="https://app.plain.com/workspace/w_01J7WXJG68TFDV9RD1C4JE3W6F/thread/<threadId>/" target="_blank" rel="noopener noreferrer"><ticket title></a> <a href="https://os.tella.dev/support/<threadId>">(session)</a>\`. The name opens Plain externally; only the literal \`(session)\` opens OpenSession in the current app. Publish it with opensession-report's publish_report — title, the full HTML, and a 1-2 sentence summary with the counts (including the easy count) and the top action.

Finish your reply with a 3-5 line text summary: headline counts (including how many easy tickets) and the top 2 recommended actions.

Hard rules: read-only towards Plain — never reply to a customer, never change thread status/priority/assignee/labels, never write Plain notes. One workflow run, one published report per run.`;

export function ensureSupportDigestAutomation(): void {
  if (listAutomations().some((a) => a.eventKey === EVENT_KEY)) return;
  const created = createAutomation({
    name: SUPPORT_DIGEST_NAME,
    prompt: SUPPORT_DIGEST_PROMPT,
    schedule: "0 6 * * *", // ~8am Amsterdam (drifts 1h with DST; cron is UTC)
    mode: "ask",
    createdBy: `${personaName()} (plain agent)`,
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
