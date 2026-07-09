/**
 * Plain and Linear API helpers for the Plain agent.
 */
import { PlainClient } from "@team-plain/typescript-sdk";
import { loadTokens, getValidToken } from "../linear/oauth";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";

const PLAIN_API_KEY = process.env.PLAIN_API_KEY || "";
const LINEAR_API_KEY = process.env.LINEAR_API_KEY || "";

export const plain = new PlainClient({ apiKey: PLAIN_API_KEY });

/** Get thread with full timeline entries */
export async function getThreadWithMessages(threadId: string): Promise<any> {
  const query = `
    query GetThreadWithMessages($threadId: ID!) {
      thread(threadId: $threadId) {
        id
        title
        description
        status
        priority
        customer {
          id
          fullName
          email {
            email
          }
          externalId
          markedAsSpamAt {
            iso8601
          }
        }
        timelineEntries(first: 100) {
          edges {
            node {
              id
              timestamp {
                iso8601
              }
              actor {
                __typename
                ... on UserActor {
                  userId
                  user {
                    fullName
                    email
                  }
                }
                ... on CustomerActor {
                  customerId
                  customer {
                    fullName
                    email {
                      email
                    }
                  }
                }
                ... on SystemActor {
                  systemId
                }
                ... on MachineUserActor {
                  machineUserId
                  machineUser {
                    fullName
                  }
                }
              }
              entry {
                __typename
                ... on NoteEntry {
                  noteId
                  noteText: text
                  markdown
                }
                ... on EmailEntry {
                  emailId
                  from {
                    name
                    email
                  }
                  to {
                    name
                    email
                  }
                  subject
                  textContent
                }
                ... on ChatEntry {
                  chatId
                  text
                }
              }
            }
          }
        }
      }
    }
  `;

  const result = await plain.rawRequest({
    query,
    variables: { threadId },
  });

  if (result.error) {
    throw new Error(`Failed to get thread with messages: ${result.error.message}`);
  }

  return (result.data as any).thread;
}

/** A single, UI-ready message in a Plain thread's timeline. */
export interface NormalizedPlainEntry {
  id: string;
  timestamp: string;
  actorName: string;
  actorType: "customer" | "support" | "bot" | "system";
  kind: "email" | "chat" | "note";
  subject?: string;
  text: string;
}

/** A Plain thread flattened to the shape the backstage sidebar renders. */
export interface NormalizedPlainThread {
  id: string;
  title: string | null;
  status: string | null;
  priority: number | null;
  customer: {
    id: string | null;
    name: string | null;
    email: string | null;
    isSpam: boolean;
  };
  entries: NormalizedPlainEntry[];
}

/**
 * Flatten the raw `getThreadWithMessages` payload into the message list the
 * session viewer's Plain sidebar renders: customer/support/bot emails & chats
 * plus internal notes, sorted oldest-first. Status-change and other non-message
 * timeline entries are dropped.
 */
export function normalizePlainThread(thread: any): NormalizedPlainThread {
  const entries: NormalizedPlainEntry[] = [];
  for (const edge of thread?.timelineEntries?.edges || []) {
    const node = edge?.node;
    const actor = node?.actor;
    const entry = node?.entry;
    if (!entry) continue;

    let actorName = "Unknown";
    let actorType: NormalizedPlainEntry["actorType"] = "system";
    if (actor?.__typename === "CustomerActor") {
      actorName =
        actor.customer?.fullName || actor.customer?.email?.email || "Customer";
      actorType = "customer";
    } else if (actor?.__typename === "UserActor") {
      actorName = actor.user?.fullName || actor.user?.email || "Support";
      actorType = "support";
    } else if (actor?.__typename === "MachineUserActor") {
      actorName = actor.machineUser?.fullName || "Bot";
      actorType = "bot";
    } else if (actor?.__typename === "SystemActor") {
      actorName = "System";
      actorType = "system";
    }

    let kind: NormalizedPlainEntry["kind"];
    let text = "";
    let subject: string | undefined;
    if (entry.__typename === "EmailEntry") {
      kind = "email";
      subject = entry.subject || undefined;
      text = entry.textContent || "";
    } else if (entry.__typename === "ChatEntry") {
      kind = "chat";
      text = entry.text || "";
    } else if (entry.__typename === "NoteEntry") {
      kind = "note";
      text = entry.markdown || entry.noteText || "";
    } else {
      continue; // status changes, assignments, etc. — not part of the conversation
    }
    if (!text.trim()) continue;

    entries.push({
      id: node.id,
      timestamp: node.timestamp?.iso8601 || "",
      actorName,
      actorType,
      kind,
      subject,
      text,
    });
  }

  entries.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return {
    id: thread?.id,
    title: thread?.title || null,
    status: thread?.status || null,
    priority: thread?.priority ?? null,
    customer: {
      id: thread?.customer?.id || null,
      name: thread?.customer?.fullName || null,
      email: thread?.customer?.email?.email || null,
      isSpam: Boolean(thread?.customer?.markedAsSpamAt?.iso8601),
    },
    entries,
  };
}

/** A TODO-queue thread summary for the Backstage Support sidebar. */
export interface SupportThreadSummary {
  id: string;
  title: string | null;
  previewText: string | null;
  status: string | null;
  statusChangedAt: string | null;
  createdAt: string | null;
  priority: number | null;
  customer: { name: string | null; email: string | null };
}

/**
 * All TODO threads, newest status change first — the same ordering as Plain's
 * own Todo inbox. Feeds the sidebar's Support section.
 */
export async function listTodoThreads(limit: number = 50): Promise<SupportThreadSummary[]> {
  const query = `
    query TodoThreads($filters: ThreadsFilter, $sortBy: ThreadsSort, $first: Int!) {
      threads(filters: $filters, sortBy: $sortBy, first: $first) {
        edges {
          node {
            id
            title
            previewText
            status
            statusChangedAt {
              iso8601
            }
            createdAt {
              iso8601
            }
            priority
            customer {
              fullName
              email {
                email
              }
            }
          }
        }
      }
    }
  `;

  const result = await plain.rawRequest({
    query,
    variables: {
      filters: { statuses: ["TODO"] },
      sortBy: { field: "STATUS_CHANGED_AT", direction: "DESC" },
      first: limit,
    },
  });

  if (result.error) {
    throw new Error(`Failed to list TODO threads: ${result.error.message}`);
  }

  const edges = (result.data as any).threads?.edges || [];
  return edges.map((e: any) => {
    const n = e?.node || {};
    return {
      id: n.id,
      title: n.title || null,
      previewText: n.previewText || null,
      status: n.status || null,
      statusChangedAt: n.statusChangedAt?.iso8601 || null,
      createdAt: n.createdAt?.iso8601 || null,
      priority: n.priority ?? null,
      customer: {
        name: n.customer?.fullName || null,
        email: n.customer?.email?.email || null,
      },
    };
  });
}

/** Search for threads */
export async function searchThreads(query: string, limit: number = 10): Promise<any[]> {
  const gqlQuery = `
    query SearchThreads($filters: ThreadsFilter!, $first: Int!) {
      threads(filters: $filters, first: $first) {
        edges {
          node {
            id
            title
            previewText
            status
            customer {
              fullName
              email {
                email
              }
            }
          }
        }
      }
    }
  `;

  const result = await plain.rawRequest({
    query: gqlQuery,
    variables: {
      filters: {},
      first: limit,
    },
  });

  if (result.error) {
    console.error("Search error:", result.error);
    return [];
  }

  return (result.data as any).threads?.edges?.map((e: any) => e.node) || [];
}

/** Get customer details */
export async function getCustomerDetails(customerId: string): Promise<any> {
  const query = `
    query GetCustomer($customerId: ID!) {
      customer(customerId: $customerId) {
        id
        fullName
        shortName
        email {
          email
          isVerified
        }
        externalId
        status
        createdAt {
          iso8601
        }
        updatedAt {
          iso8601
        }
        markedAsSpamAt {
          iso8601
        }
      }
    }
  `;

  const result = await plain.rawRequest({
    query,
    variables: { customerId },
  });

  if (result.error) {
    throw new Error(`Failed to get customer: ${result.error.message}`);
  }

  return (result.data as any).customer;
}

/** Post an internal note to a thread */
export async function postNote(
  threadId: string,
  customerId: string,
  text: string,
  markdown?: string
): Promise<boolean> {
  try {
    const result = await plain.createNote({
      threadId,
      customerId,
      text,
      markdown: markdown || text,
    });

    if (result.error) {
      console.error("Error creating note:", result.error);
      return false;
    }

    console.log(`[plain] Posted note to thread ${threadId}`);
    return true;
  } catch (e) {
    console.error("Error posting note:", e);
    return false;
  }
}

/** Clean up draft text — remove markdown artifacts and normalize */
export function cleanDraftText(text: string): string {
  return text
    .replace(/^>\s?/gm, "")
    .replace(/\*\*\s*\*\*/g, "")
    .replace(/^\s*\*+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Send a reply to the customer (email/chat based on thread type) */
export async function sendCustomerReply(
  threadId: string,
  customerId: string,
  text: string
): Promise<boolean> {
  try {
    const cleanText = cleanDraftText(text);

    const result = await plain.replyToThread({
      threadId,
      textContent: cleanText,
    });

    if (result.error) {
      console.error("Error sending reply:", result.error);
      return false;
    }

    console.log(`[plain] Sent reply to customer in thread ${threadId}`);
    return true;
  } catch (e) {
    console.error("Error sending reply:", e);
    return false;
  }
}

/** Statuses a human can set on a thread from the Support UI. */
export type ThreadStatusAction = "todo" | "done" | "snoozed";

/**
 * Change a thread's status the way Plain's own inbox does: Done closes it,
 * Todo (re)opens/unsnoozes it, Snoozed parks it for `durationSeconds`
 * (default 1 day, after which Plain flips it back to Todo).
 */
export async function setThreadStatus(
  threadId: string,
  status: ThreadStatusAction,
  durationSeconds?: number,
): Promise<void> {
  const result =
    status === "done"
      ? await plain.markThreadAsDone({ threadId })
      : status === "todo"
        ? await plain.markThreadAsTodo({ threadId })
        : await plain.snoozeThread({
            threadId,
            durationSeconds: Math.max(
              60,
              Math.floor(durationSeconds ?? 86_400),
            ),
          });
  if (result.error) {
    throw new Error(
      `Failed to mark thread ${status}: ${result.error.message}`,
    );
  }
}

/** Plain thread priorities: 0 = Urgent, 1 = High, 2 = Normal, 3 = Low. */
export async function setThreadPriority(
  threadId: string,
  priority: number,
): Promise<void> {
  if (![0, 1, 2, 3].includes(priority)) {
    throw new Error(`Invalid priority ${priority} (0=Urgent … 3=Low)`);
  }
  const result = await plain.changeThreadPriority({ threadId, priority });
  if (result.error) {
    throw new Error(`Failed to change priority: ${result.error.message}`);
  }
}

/**
 * Mark or unmark a customer as spam. Plain tracks spam on the customer, not
 * the thread (all their future threads get filtered too); the SDK has no
 * method for these mutations, so raw GraphQL.
 */
export async function setCustomerSpam(
  customerId: string,
  spam: boolean,
): Promise<void> {
  const mutation = spam ? "markCustomerAsSpam" : "unmarkCustomerAsSpam";
  const inputType = spam
    ? "MarkCustomerAsSpamInput"
    : "UnmarkCustomerAsSpamInput";
  const result = await plain.rawRequest({
    query: `
      mutation SetCustomerSpam($input: ${inputType}!) {
        ${mutation}(input: $input) {
          error {
            message
          }
        }
      }
    `,
    variables: { input: { customerId } },
  });
  if (result.error) {
    throw new Error(`${mutation} failed: ${result.error.message}`);
  }
  const err = (result.data as any)?.[mutation]?.error;
  if (err?.message) {
    throw new Error(`${mutation} failed: ${err.message}`);
  }
}

/** Format thread context for Claude */
export function formatThreadContext(thread: any, includeAllMessages: boolean = false): string {
  if (!thread) {
    return "Thread information not available.";
  }

  let context = `**Thread ID:** ${thread.id}\n`;
  context += `**Customer:** ${thread.customer.fullName || thread.customer.email?.email || thread.customer.id}\n`;
  if (thread.customer.email?.email) {
    context += `**Customer Email:** ${thread.customer.email.email}\n`;
  }
  context += `**Status:** ${thread.status}\n`;
  context += `**Priority:** ${thread.priority}\n`;

  if (thread.title) {
    context += `**Title:** ${thread.title}\n`;
  }

  if (thread.description) {
    context += `\n**Description:**\n${thread.description}\n`;
  }

  context += `\n**Conversation History:**\n\n`;

  thread.timelineEntries?.edges?.forEach((edge: any) => {
    const node = edge.node;
    const entry = node.entry;
    const actor = node.actor;
    const timestamp = node.timestamp?.iso8601 || "";

    let actorName = "Unknown";
    let actorType = "unknown";

    if (actor?.__typename === "CustomerActor") {
      actorName = actor.customer?.fullName || actor.customer?.email?.email || "Customer";
      actorType = "customer";
    } else if (actor?.__typename === "UserActor") {
      actorName = actor.user?.fullName || actor.user?.email || "Support";
      actorType = "support";
    } else if (actor?.__typename === "MachineUserActor") {
      actorName = actor.machineUser?.fullName || "Bot";
      actorType = "bot";
    }

    if (!includeAllMessages && actorType !== "customer") {
      return;
    }

    if (entry) {
      if (entry.__typename === "EmailEntry" && entry.textContent) {
        context += `**[${actorType.toUpperCase()}] ${actorName}** (${timestamp}):\n${entry.textContent}\n\n---\n\n`;
      } else if (entry.__typename === "ChatEntry" && entry.text) {
        context += `**[${actorType.toUpperCase()}] ${actorName}** (${timestamp}):\n${entry.text}\n\n---\n\n`;
      } else if (entry.__typename === "NoteEntry" && entry.noteText) {
        context += `**[NOTE] ${actorName}** (${timestamp}):\n${entry.noteText}\n\n---\n\n`;
      }
    }
  });

  return context;
}

/**
 * Resolve a Linear Authorization header. Prefers the Linear agent's OAuth
 * token store (~/.linear-agent-tokens.json, auto-refreshed) and falls back to
 * the LINEAR_API_KEY env var (bare for personal lin_api_ keys, Bearer otherwise).
 */
async function linearAuthHeader(): Promise<string | null> {
  const tokens = await loadTokens();
  for (const orgId of Object.keys(tokens)) {
    const token = await getValidToken(orgId, tokens);
    if (token) return `Bearer ${token}`;
  }
  if (LINEAR_API_KEY) {
    return LINEAR_API_KEY.startsWith("lin_api_") ? LINEAR_API_KEY : `Bearer ${LINEAR_API_KEY}`;
  }
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const teamIdCache = new Map<string, string>();

/** Resolve a team key (e.g. "TELLA") to its UUID — issueCreate only accepts UUIDs. */
async function resolveLinearTeamId(auth: string, team: string): Promise<string | null> {
  if (UUID_RE.test(team)) return team;
  const cached = teamIdCache.get(team);
  if (cached) return cached;

  const response = await fetchWithTimeout("https://api.linear.app/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: auth },
    body: JSON.stringify({
      query: `
        query TeamByKey($key: String!) {
          teams(filter: { key: { eq: $key } }, first: 1) {
            nodes { id }
          }
        }
      `,
      variables: { key: team },
    }),
  });
  const data = await response.json();
  const id = data.data?.teams?.nodes?.[0]?.id;
  if (id) {
    teamIdCache.set(team, id);
    return id;
  }
  console.error(`Linear team not found for key "${team}":`, data.errors || data);
  return null;
}

/** Create a Linear issue */
export async function createLinearIssue(
  title: string,
  description: string,
  teamId?: string
): Promise<{ id: string; identifier: string; url: string } | null> {
  const auth = await linearAuthHeader();
  if (!auth) {
    console.error("No Linear credentials (OAuth token store empty and LINEAR_API_KEY unset)");
    return null;
  }

  try {
    const resolvedTeamId = await resolveLinearTeamId(auth, teamId || "TELLA");
    if (!resolvedTeamId) return null;

    const response = await fetchWithTimeout("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({
        query: `
          mutation CreateIssue($input: IssueCreateInput!) {
            issueCreate(input: $input) {
              success
              issue {
                id
                identifier
                url
              }
            }
          }
        `,
        variables: {
          input: {
            title,
            description,
            teamId: resolvedTeamId,
          },
        },
      }),
    });

    const data = await response.json();
    if (data.data?.issueCreate?.success) {
      return data.data.issueCreate.issue;
    }
    console.error("Linear issue creation failed:", data);
    return null;
  } catch (e) {
    console.error("Error creating Linear issue:", e);
    return null;
  }
}

/** Search Linear for issues */
export async function searchLinearIssues(
  query: string,
  limit: number = 5
): Promise<Array<{ id: string; identifier: string; title: string; url: string; state: string }>> {
  const auth = await linearAuthHeader();
  if (!auth) {
    console.error("No Linear credentials (OAuth token store empty and LINEAR_API_KEY unset)");
    return [];
  }

  try {
    const response = await fetchWithTimeout("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: auth,
      },
      body: JSON.stringify({
        query: `
          query SearchIssues($query: String!, $first: Int!) {
            searchIssues(query: $query, first: $first) {
              nodes {
                id
                identifier
                title
                url
                state {
                  name
                }
              }
            }
          }
        `,
        variables: {
          query,
          first: limit,
        },
      }),
    });

    const data = await response.json();
    if (data.data?.searchIssues?.nodes) {
      return data.data.searchIssues.nodes.map((node: any) => ({
        id: node.id,
        identifier: node.identifier,
        title: node.title,
        url: node.url,
        state: node.state?.name || "Unknown",
      }));
    }
    return [];
  } catch (e) {
    console.error("Error searching Linear:", e);
    return [];
  }
}
