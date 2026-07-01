/**
 * Plain and Linear API helpers for the Plain agent.
 */
import { PlainClient } from "@team-plain/typescript-sdk";

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
  customer: { name: string | null; email: string | null };
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
      name: thread?.customer?.fullName || null,
      email: thread?.customer?.email?.email || null,
    },
    entries,
  };
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

/** Create a Linear issue */
export async function createLinearIssue(
  title: string,
  description: string,
  teamId?: string
): Promise<{ id: string; identifier: string; url: string } | null> {
  if (!LINEAR_API_KEY) {
    console.error("LINEAR_API_KEY not configured");
    return null;
  }

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: LINEAR_API_KEY,
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
            teamId: teamId || "TEL",
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
  if (!LINEAR_API_KEY) {
    console.error("LINEAR_API_KEY not configured");
    return [];
  }

  try {
    const response = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: LINEAR_API_KEY,
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
