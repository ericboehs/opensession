/**
 * Plain "Top Issues" rollup data: Linear issues ranked by linked Plain threads,
 * plus which got NEW links since the previous weekday run, with a customer-quote
 * source thread for each shown issue.
 *
 * Deterministic data layer for the Top Issues rollup automation. Run as a CLI
 * (`bun src/agents/plain/top-issues.ts`) it prints JSON the automation agent turns
 * into a Slack rollup (it writes the nice quotes + prose). Stateless: the "new
 * links" window is derived from the weekday (Mon looks back over the weekend).
 */
import { readFileSync } from "fs";
import { opencodeOneShot } from "../../server/opencode-oneshot";
import { statePath } from "../../server/rename-compat";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";

const PLAIN_API_URL = process.env.PLAIN_API_URL || "https://core-api.uk.plain.com/graphql/v1";
const CHAT_CHANNEL = "C01ED50A2KG"; // #chat
const TOP_ISSUES_URL =
  "https://app.plain.com/workspace/w_01J7WXJG68TFDV9RD1C4JE3W6F/insights/top-issues/";
const QUOTE_MODEL = process.env.PLAIN_TOPISSUES_QUOTE_MODEL || "claude-haiku-4-5";
// Automation runs get a minimal env (no tokens), so fall back to the env file the
// cron scripts use — HOME is always present.
function plainKey(): string {
  if (process.env.PLAIN_API_KEY) return process.env.PLAIN_API_KEY;
  try {
    const txt = readFileSync(`${process.env.HOME || "/home/ubuntu"}/.plain-agent.env`, "utf8");
    const m = txt.match(/^PLAIN_API_KEY=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {}
  return "";
}
const PLAIN_API_KEY = plainKey();

async function gql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const res = await fetchWithTimeout(PLAIN_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${PLAIN_API_KEY}` },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error("Plain GraphQL: " + JSON.stringify(json.errors).slice(0, 500));
  return json.data;
}

export interface IssueRollup {
  rank: number | null;
  title: string;
  /** Title without the ": …" descriptor suffix, for a tidy display name. */
  shortName: string;
  url: string;
  /** Ready-to-use Slack link the agent should drop in verbatim, so links never get mangled. */
  slackLink: string;
  totalLinks: number;
  newLinks: number;
  /** Raw inbound customer texts from linked threads — a Haiku step picks the nicest genuine on-topic quote. */
  quoteCandidates: string[];
}

export interface TopIssuesData {
  windowSinceIso: string;
  windowLabel: string;
  totalNewLinks: number;
  shouldPost: boolean;
  top3: IssueRollup[];
  movers: IssueRollup[]; // got new links, not already in top3, by newLinks desc
}

// UTC weekdays the rollup runs (0=Sun..6=Sat). Keep in sync with the automation
// cron `0 14 * * 2,4`. The "new links" window = since the previous scheduled run.
const RUN_DAYS = [2, 4]; // Tue, Thu

/** 14:00 UTC of the most recent prior run day (so the window covers since the last rollup). */
function windowSince(now: Date): Date {
  for (let back = 1; back <= 7; back++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 14, 0, 0));
    d.setUTCDate(d.getUTCDate() - back);
    if (RUN_DAYS.includes(d.getUTCDay())) return d;
  }
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - 7);
  return d;
}

async function fetchAllGroups(): Promise<any[]> {
  const groups: any[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data: any = await gql(
      `query($after:String){threadLinkGroups(first:50,after:$after){pageInfo{hasNextPage endCursor}edges{node{
        id currentViewRank
        threadLinks(first:100){totalCount edges{node{title url sourceType threadId createdAt{iso8601}}}}
      }}}}`,
      { after }
    );
    const conn = data.threadLinkGroups;
    for (const e of conn.edges) groups.push(e.node);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return groups;
}

/**
 * Inbound customer texts from a thread (no classification — a Haiku step judges
 * which is a genuine on-topic quote). previewText is the customer's opening
 * message; inbound emails/chats (Customer or System actor — inbound shows as
 * System) add context. Outbound support (UserActor) and bots are excluded.
 * Only whitespace/length hygiene here, no regex filtering of content.
 */
async function customerTextsFor(threadId: string): Promise<string[]> {
  try {
    const data = await gql(
      `query($id:ID!){thread(threadId:$id){previewText timelineEntries(first:60){edges{node{
        actor{__typename}
        entry{__typename ... on EmailEntry{textContent} ... on ChatEntry{text}}
      }}}}}`,
      { id: threadId }
    );
    const out: string[] = [];
    const push = (t?: string) => {
      const clean = (t || "").trim().replace(/\s+/g, " ").slice(0, 800);
      if (clean && !out.includes(clean)) out.push(clean);
    };
    push(data.thread?.previewText);
    for (const e of data.thread?.timelineEntries?.edges || []) {
      const actor = e.node.actor?.__typename;
      if (actor !== "CustomerActor" && actor !== "SystemActor") continue; // inbound only
      push(e.node.entry?.textContent || e.node.entry?.text);
    }
    return out.slice(0, 5);
  } catch {
    return [];
  }
}

/** Collect raw quote candidates across several of an issue's linked threads. */
async function gatherCandidates(threadIds: string[]): Promise<string[]> {
  const cands: string[] = [];
  for (const tid of threadIds.slice(0, 6)) {
    if (cands.length >= 8) break;
    for (const t of await customerTextsFor(tid)) if (!cands.includes(t)) cands.push(t);
  }
  return cands.slice(0, 8);
}

export async function getTopIssuesData(now: Date = new Date()): Promise<TopIssuesData> {
  const since = windowSince(now);
  const sinceMs = since.getTime();
  const groups = await fetchAllGroups();

  const issues = groups.map((g) => {
    const links = g.threadLinks.edges.map((e: any) => e.node);
    const first = links[0] || {};
    const newOnes = links.filter((l: any) => {
      const t = Date.parse(l.createdAt?.iso8601 || "");
      return Number.isFinite(t) && t >= sinceMs;
    });
    // Candidate quote threads: newly-linked first (freshest customer voice), then the rest.
    const candidateThreadIds = [
      ...newOnes.map((l: any) => l.threadId),
      ...links.map((l: any) => l.threadId),
    ].filter((v, i, a) => v && a.indexOf(v) === i);
    const title = first.title || "(untitled issue)";
    const shortName = title.split(":")[0].trim() || title;
    const url = first.url || "";
    return {
      rank: g.currentViewRank ?? null,
      title,
      shortName,
      url,
      slackLink: url ? `<${url}|${shortName}>` : `*${shortName}*`,
      totalLinks: g.threadLinks.totalCount,
      newLinks: newOnes.length,
      candidateThreadIds,
      quoteCandidates: [] as string[],
    } as IssueRollup & { candidateThreadIds: string[] };
  });

  const byRank = [...issues].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const top3 = byRank.slice(0, 3);
  const top3Urls = new Set(top3.map((i) => i.url));
  const movers = issues
    .filter((i) => i.newLinks > 0 && !top3Urls.has(i.url))
    .sort((a, b) => b.newLinks - a.newLinks)
    .slice(0, 3); // top 3 movers; the rest are covered by the "view all" footer link

  const totalNewLinks = issues.reduce((s, i) => s + i.newLinks, 0);

  // Hydrate quote candidates only for what we'll show, then drop the thread-id scratch field.
  for (const i of [...top3, ...movers] as Array<IssueRollup & { candidateThreadIds: string[] }>) {
    i.quoteCandidates = await gatherCandidates(i.candidateThreadIds);
    delete (i as any).candidateThreadIds;
  }

  return {
    windowSinceIso: since.toISOString(),
    windowLabel: since.toUTCString(),
    totalNewLinks,
    shouldPost: totalNewLinks > 0,
    top3,
    movers,
  };
}

// ── Quote picking (Haiku) ─────────────────────────────────────────────────
const QUOTE_SYSTEM = `You pick the single best customer quote for each feature request, from candidate support messages.
For each issue choose the quote that is the CUSTOMER's OWN words about THAT feature.
IGNORE: auto-replies ("Thanks for reaching out", "normal support hours"), CSAT/survey emails ("we'd love your feedback"), support/agent messages, quoted email reply chains, signatures, and anything off-topic.
Trim to one clean sentence (~max 200 chars), fix obvious typos lightly, keep the customer's voice, don't invent words.
If NONE of an issue's candidates is a clean on-topic customer quote, use an empty string for it.
Respond with ONLY a JSON array of strings, one per issue, in the same order.`;

/** One Haiku call → best quote per issue (or "" ). Fail-soft: all "" on error. */
async function pickQuotes(issues: IssueRollup[]): Promise<string[]> {
  const blank = issues.map(() => "");
  if (!issues.length) return blank;
  const payload = issues.map((i, n) => ({ n, feature: i.shortName, candidates: i.quoteCandidates }));
  try {
    const out = await opencodeOneShot(
      `Pick a quote for each of these ${issues.length} issues:\n\n${JSON.stringify(payload).slice(0, 22000)}`,
      { system: QUOTE_SYSTEM, model: QUOTE_MODEL, label: "top-issues-quotes" },
    );
    if (!out) return blank;
    const match = out.match(/\[[\s\S]*\]/);
    if (!match) return blank;
    const arr = JSON.parse(match[0]);
    return issues.map((_, n) => (typeof arr[n] === "string" ? arr[n].trim() : ""));
  } catch (e) {
    console.error("[top-issues] quote pick failed (using none):", e);
    return blank;
  }
}

// ── Message assembly + Slack post (unfurl disabled) ───────────────────────
function quoteLine(q: string): string {
  return q ? `> "${q}"` : `> _(newly linked — no clean customer quote yet)_`;
}

function assembleMessage(data: TopIssuesData, top3q: string[], moverq: string[]): string {
  const L: string[] = [];
  L.push(`:bar_chart: *Plain Top Issues rollup*  ·  _${data.totalNewLinks} new customer links since ${data.windowLabel}_`);
  L.push("Michael here :wave: — what customers are asking for most, and what moved since the last rollup.");
  L.push("");
  L.push(":trophy: *Top 3 most-requested*");
  data.top3.forEach((i, n) => {
    L.push(`${n + 1}. ${i.slackLink}  ·  ${i.totalLinks} linked tickets`);
    L.push(quoteLine(top3q[n]));
  });
  if (data.movers.length) {
    L.push("");
    L.push(":chart_with_upwards_trend: *Got new links since the last rollup*");
    data.movers.forEach((i, n) => {
      L.push(`• ${i.slackLink}  ·  ${i.totalLinks} linked · +${i.newLinks} new`);
      L.push(quoteLine(moverq[n]));
    });
  }
  L.push("");
  L.push(`:mag: <${TOP_ISSUES_URL}|View all top issues in Plain →>`);
  return L.join("\n");
}

function slackToken(): string {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  const home = process.env.HOME || "/home/ubuntu";
  try {
    const envFile = statePath(".opensession.env", ".backstage.env");
    const m = readFileSync(envFile, "utf8").match(/^SLACK_BOT_TOKEN=(.*)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(`${home}/projects/tella-backstage/mcp-config.json`, "utf8"));
    return cfg.mcpServers?.slack?.env?.SLACK_BOT_TOKEN || "";
  } catch {}
  return "";
}

/** Post to Slack with link unfurling OFF so the many Linear links stay compact. */
async function postToSlack(channel: string, text: string): Promise<void> {
  const res = await fetchWithTimeout("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${slackToken()}` },
    body: JSON.stringify({ channel, text, mrkdwn: true, unfurl_links: false, unfurl_media: false }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error("Slack post failed: " + JSON.stringify(json).slice(0, 300));
}

/** Full pipeline used by the automation: fetch → pick quotes (Haiku) → post (only if new links). */
export async function runAndPost(): Promise<string> {
  const data = await getTopIssuesData();
  if (!data.shouldPost) return "No new customer links since the last rollup — nothing posted.";
  const [top3q, moverq] = await Promise.all([pickQuotes(data.top3), pickQuotes(data.movers)]);
  const message = assembleMessage(data, top3q, moverq);
  await postToSlack(CHAT_CHANNEL, message);
  return `Posted rollup to #chat: ${data.top3.length} top issues + ${data.movers.length} movers (${data.totalNewLinks} new links).`;
}

if (import.meta.main) {
  if (process.argv.includes("--post")) {
    console.log(await runAndPost());
  } else {
    console.log(JSON.stringify(await getTopIssuesData(), null, 2));
  }
}
