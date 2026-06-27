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

const PLAIN_API_URL = process.env.PLAIN_API_URL || "https://core-api.uk.plain.com/graphql/v1";
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
  const res = await fetch(PLAIN_API_URL, {
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
  url: string;
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
    return {
      rank: g.currentViewRank ?? null,
      title: first.title || "(untitled issue)",
      url: first.url || "",
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
    .sort((a, b) => b.newLinks - a.newLinks);

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

if (import.meta.main) {
  const data = await getTopIssuesData();
  console.log(JSON.stringify(data, null, 2));
}
