/**
 * Cron jobs migrated from ~/scripts/*.sh into backstage automations, code-seeded so
 * they're reproducible + version-controlled (create-if-absent by eventKey; UI edits
 * preserved). These replace the equivalent crontab entries (commented out there).
 *
 * NOT migrated (kept as cron, on purpose): loom-complaints (headless-Chrome scraping),
 * refresh-plain-knowledge (deterministic Plain GraphQL reindex, needs the raw key),
 * mrr-milestone-check + backstage-status (every-minute — an LLM there is the wrong
 * tool), backup-ami + cleanup-closed-worktrees (infra).
 */
import { listAutomations, createAutomation } from "../../server/automations";
import { defaultRepo } from "../../server/config";

const REPO = defaultRepo().ghRepo;
const CHAT = "C01ED50A2KG"; // #chat
const DOCS_CHANNEL = "C09BAFFK8F8";
const JOHNNY = "U0866D7PCCU"; // Johnny Lin

interface CronJobSeed {
  eventKey: string;
  name: string;
  schedule: string; // 5-field UTC cron
  mode: "ask" | "code";
  mcpServers: string[];
  model?: string;
  prompt: string;
}

const CRON_JOBS: CronJobSeed[] = [
  {
    eventKey: "cron:top-videos-weekly",
    name: "Top Videos Weekly",
    schedule: "0 14 * * 5",
    mode: "ask",
    mcpServers: ["tinybird", "slack"],
    model: "claude-sonnet-4-6",
    prompt: `You are Michael. Post the week's top 5 most-watched Tella videos to Slack channel \`${CHAT}\` (#chat).

Permissions: read-only except the one Slack post via the MCP, which is the point of this run — don't refuse it.

1. Query Tinybird (Tinybird MCP) for the top 5 storyIDs by play count over the last 7 days: from \`view_events\`, count rows where \`eventType = 'view_start'\` and \`timestamp >= now() - INTERVAL 7 DAY\`, GROUP BY \`storyID\`, ORDER BY count DESC, LIMIT 5.
2. For each storyID, get its title by fetching \`https://www.tella.tv/video/<storyID>/view\` (Bash \`curl -sL\` and read the <title>) — fall back to "(untitled)" if none.
3. Post ONE message titled "*Top 5 Most Watched Tella Videos This Week* :tv:" with a numbered list: rank, play count, and the title linked to \`https://www.tella.tv/video/<storyID>/view\`. Keep it tidy and skimmable.
If Tinybird returns no rows, post nothing.`,
  },
  {
    eventKey: "cron:vrijmibo",
    name: "Vrijmibo",
    schedule: "30 14 * * 5",
    mode: "ask",
    mcpServers: ["slack"],
    model: "claude-sonnet-4-6",
    prompt: `You are Michael. Post ONE fun "vrijmibo" (Friday drinks) message to Slack channel \`${CHAT}\` (#chat) via the Slack MCP \`conversations_add_message\` to get the team hyped for Friday drinks. Be funny, use emojis, remind everyone to join the huddle, keep it short. Posting to Slack is the entire purpose of this run — just do it (write the message yourself and post it; no preamble, no meta-commentary).`,
  },
  {
    eventKey: "cron:weekly-changelog",
    name: "Weekly Changelog Draft",
    schedule: "0 15 * * 5",
    mode: "code",
    mcpServers: ["slack"],
    prompt: `You are Michael, drafting Tella's weekly changelog. Work in your worktree (a fresh checkout of ${REPO} main). The changelog lives at \`packages/core/webapp/docs/changelog.mdx\`.

1. DEDUP: \`gh pr list --repo ${REPO} --state open --json url,headRefName --limit 50\` — if any open PR's branch starts with \`weekly-changelog-\`, STOP (a draft is already awaiting review).
2. Find the most recent entry's date: the top \`<Update label="...">\` in changelog.mdx. Get user-facing PRs merged since then: \`gh pr list --repo ${REPO} --state merged --base main --search "merged:><date>" --json number,title,body,mergedAt,author,url,labels --limit 300\`.
3. Draft ONE new \`<Update label="<Month D, YYYY>">...</Update>\` block to insert at the very top (right after the frontmatter). Rules: ONLY user-facing changes (features, behavior, notable fixes). EXCLUDE internal refactors, CI/CD, dep bumps, tooling, infra, AGENTS.md/CLAUDE.md edits, perf-with-no-observable-impact, anything behind an internal flag / WIP / staff-only, and doc-only changes. No internal repo paths / module names / code. Match the tone, length, and structure of recent entries. Never repeat anything already in the changelog.
4. If nothing user-facing is worth shipping, STOP and open no PR.
5. Otherwise insert the block, then on a branch \`weekly-changelog-<YYYY-MM-DD>\`: commit just changelog.mdx, push, and \`gh pr create --repo ${REPO} --base main --title "Changelog draft: week of <Month D, YYYY>" --body "Automated draft from PRs merged since the previous entry. Please review, edit, and merge — future runs skip while this PR is open."\`. NEVER \`gh pr merge\`.
6. Post the PR link to Slack channel \`${CHAT}\` (#chat) via the Slack MCP: ":memo: *Weekly changelog draft ready for review*\\n<PR url>\\nPlease edit/approve before merging. — Michael".`,
  },
  {
    eventKey: "cron:docs-spell-check",
    name: "Docs Spell-Check",
    schedule: "0 16 * * 1",
    mode: "code",
    mcpServers: ["slack"],
    model: "claude-sonnet-4-6",
    prompt: `You are Michael, doing the weekly docs spell-check. Work in your worktree (fresh ${REPO} main). Docs live under \`packages/core/webapp/docs/\`.

1. DEDUP: \`gh pr list --repo ${REPO} --state open --json url,headRefName --limit 50\` — if any open PR's branch starts with \`docs-spell-check-\`, STOP.
2. Scan all MDX under \`packages/core/webapp/docs/**/*.mdx\` (use Glob) for clear spelling errors, grammatical mistakes, broken markdown (unclosed bold/italic, malformed links/tables), duplicate words ("the the"), bad punctuation (double spaces, mismatched quotes), and broken frontmatter. Fix them in place.
   DO NOT: change technical terms / product names (Tella, Loom, Figma…) / API names / code; rephrase or rewrite sentences (only fix clear errors); touch fenced code blocks, inline code, or MDX component props; or change dated changelog entries in \`changelog.mdx\` beyond obvious typos.
3. If nothing changed, STOP and open no PR.
4. Otherwise on a branch \`docs-spell-check-<YYYY-MM-DD>\`: commit the docs changes, push, and \`gh pr create --repo ${REPO} --base main --title "docs: weekly spell-check fixes (<YYYY-MM-DD>)" --body "Automated spelling/grammar/formatting fixes across docs MDX. <N> file(s) modified — please review. Future runs skip while this PR is open."\` with a short summary of what you changed by category. NEVER \`gh pr merge\`.
5. Post the PR link to Slack channel \`${DOCS_CHANNEL}\` via the Slack MCP: ":memo: *Weekly docs spell-check PR ready for review*\\n<PR url>\\n<N> file(s) modified. — Michael".`,
  },
  {
    eventKey: "cron:daily-recap",
    name: "Daily Recap (Johnny)",
    schedule: "0 16 * * 1-5",
    mode: "ask",
    mcpServers: ["slack"],
    model: "claude-sonnet-4-6",
    prompt: `You are Michael. DM a concise daily recap of the EU overnight (~last 9 hours) to Johnny Lin (Slack user \`${JOHNNY}\`) via the Slack MCP \`conversations_add_message\` (channel = that user ID opens the DM). Posting that DM is the purpose of this run — read-only otherwise.

Cover the last ~9 hours:
1. **Slack**: skim the key public team channels (e.g. #chat \`${CHAT}\`, and other active product/eng channels) via the Slack MCP \`conversations_history\` — pull out decisions, questions aimed at Johnny, incidents, and noteworthy discussion. Skip noise.
2. **GitHub** (${REPO}): merged PRs and notable opened PRs in the window (\`gh pr list --repo ${REPO} --search "merged:>=<ISO 9h ago>" ...\` and recently opened), plus anything needing Johnny's review.
Then DM Johnny ONE tight, skimmable recap: a few bullets for Slack highlights, a few for GitHub, and an explicit "needs you" list if anything awaits him. Prefix that it's you, Michael. If truly nothing happened, send a one-line "quiet night" note.`,
  },
];

/** Seed the migrated cron jobs as automations (create-if-absent; preserves UI edits). */
export function ensureCronJobs(): void {
  for (const job of CRON_JOBS) {
    if (listAutomations().some((a) => a.eventKey === job.eventKey)) continue;
    const created = createAutomation({
      name: job.name,
      prompt: job.prompt,
      schedule: job.schedule,
      mode: job.mode,
      createdBy: "Michael (cron migration)",
      eventKey: job.eventKey,
      mcpServers: job.mcpServers,
      model: job.model,
    });
    if ("error" in created) {
      console.error(`[loops] Failed to seed cron job "${job.name}":`, created.error);
    } else {
      console.log(`[loops] Seeded cron job "${job.name}" (${created.id})`);
    }
  }
}
