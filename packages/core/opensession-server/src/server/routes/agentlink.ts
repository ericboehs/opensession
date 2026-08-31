/**
 * Agent Link routes: the read-only transcript panel for a mesh peer.
 *
 * Two endpoints, both GET and both read-only:
 *   /api/agentlink/peers/:id/transcript  → JSON, for clients that render it
 *   /agentlink/peer/:id                  → HTML, the feed panel's iframe
 *
 * The HTML view exists because a feed panel is an iframe (`embedUrlTemplate`).
 * It is deliberately plain: escaped text in a scrollable column, no scripts,
 * no styling framework. Peer transcripts are untrusted content — a session
 * transcript contains whatever that agent read from a diff, a web page or an
 * issue body — so nothing in it is ever interpreted as markup.
 */

import type { RouteContext } from "./context";
import {
  readPeerTranscript,
  readPeerClientTranscript,
} from "../../agents/agentlink/transcript";
import { externalSessionRows } from "../external-sessions";
import { AGENT_LINK_SOURCE } from "../../agents/agentlink";
import { promptExternalSession } from "../../agents/agentlink/session-bridge";
import { followPeerSend } from "../agentlink-follow";

const TRANSCRIPT_API = /^\/api\/agentlink\/peers\/([^/]+)\/transcript$/;
const TRANSCRIPT_VIEW = /^\/agentlink\/peer\/([^/]+)$/;
/** Session-family routes for a mesh row. Registered ahead of the generic
 *  session routes and matched only inside the `agent-link:` id namespace, so
 *  a real session can never be shadowed. */
const SESSION_DETAIL = /^\/api\/sessions\/([^/]+)$/;
const SESSION_TRANSCRIPT = /^\/api\/sessions\/([^/]+)\/transcript$/;
/** The clients' composer posts here and waits for an ack; the websocket
 *  `prompt` frame is a different path that only some surfaces use. */
const SESSION_PROMPT = /^\/api\/sessions\/([^/]+)\/prompt$/;

/** The peer session id inside a row id, or null when this is not one of ours. */
function peerSessionId(rawRowId: string): string | null {
  const rowId = decodeURIComponent(rawRowId);
  const prefix = `${AGENT_LINK_SOURCE}:`;
  if (!rowId.startsWith(prefix)) return null;
  const id = rowId.slice(prefix.length);
  // A peer with no session id is addressed by pid and has no transcript.
  return id && !/^\d+$/.test(id) ? id : null;
}

/** A mesh peer without a pi session id is addressed as `pid:<n>`; only a real
 *  session id can locate a transcript. */
function sessionIdFrom(raw: string): string | null {
  const id = decodeURIComponent(raw);
  return id.startsWith("pid:") ? null : id;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(body: string): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8">` +
      `<meta name="color-scheme" content="light dark">` +
      `<style>
        /* The host styles this iframe for video (opaque black). Paint our
           own surface or dark text renders on a dark background. Canvas /
           CanvasText are the system pair, so this still follows the
           light/dark preference declared above. */
        html { background: Canvas; color: CanvasText; }
        body { font: 13px/1.5 ui-sans-serif, system-ui, sans-serif;
               margin: 0; padding: 12px; }
        .turn { margin: 0 0 14px; }
        .role { font-weight: 600; opacity: .6; font-size: 11px;
                text-transform: uppercase; letter-spacing: .04em; }
        pre { margin: 3px 0 0; white-space: pre-wrap; word-wrap: break-word;
              font: inherit; }
        .empty { opacity: .6; }
      </style>` +
      body,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function handleAgentLinkRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  // Steering a peer from the composer. Answered before the generic session
  // routes, which resolve the id against a store no peer is in.
  const promptMatch = path.match(SESSION_PROMPT);
  if (promptMatch && req.method === "POST") {
    const sessionId = peerSessionId(promptMatch[1]);
    if (sessionId) {
      const body = (await req.json().catch(() => null)) as {
        content?: unknown;
        user?: unknown;
      } | null;
      const content = typeof body?.content === "string" ? body.content : "";
      if (!content.trim())
        return Response.json({ error: "Empty message." }, { status: 400 });
      const rowId = decodeURIComponent(promptMatch[1]);
      const user = typeof body?.user === "string" ? body.user : "";
      const result = await promptExternalSession(
        rowId,
        content,
        user || "Open Session",
      );
      // 404 tells the outbox the target is gone so it stops retrying: a peer
      // that exited will never accept this message.
      if (!result.ok)
        return Response.json({ error: result.error }, { status: 404 });
      // "queued", not "started": a `next`-priority mesh message waits for any
      // turn already in flight, and claiming otherwise would show a reply
      // that has not begun.
      // The peer writes the turn when it processes it, so follow the file for
      // a while and push what appears 2014 otherwise the send looks like it
      // vanished until the row is reopened.
      followPeerSend(rowId);
      return Response.json({
        status: "queued",
        message: "Delivered to the session.",
      });
    }
  }

  if (req.method !== "GET") return undefined;

  const api = path.match(TRANSCRIPT_API);
  if (api) {
    const sessionId = sessionIdFrom(api[1]);
    const entries = sessionId ? await readPeerTranscript(sessionId) : null;
    if (!entries) return Response.json({ error: "No transcript" }, { status: 404 });
    return Response.json({ entries });
  }

  const view = path.match(TRANSCRIPT_VIEW);
  if (view) {
    const sessionId = sessionIdFrom(view[1]);
    const entries = sessionId ? await readPeerTranscript(sessionId) : null;
    if (!entries) {
      return renderPage(
        `<p class="empty">No transcript for this session.</p>` +
          `<p class="empty">Claude Code peers register in the same mesh but ` +
          `store their history elsewhere, and a session started with ` +
          `<code>--no-session</code> is never written to disk.</p>`,
      );
    }
    if (entries.length === 0) {
      return renderPage(`<p class="empty">This session has no turns yet.</p>`);
    }
    return renderPage(
      entries
        .map(
          (e) =>
            `<div class="turn"><div class="role">${escapeHtml(e.role)}</div>` +
            `<pre>${escapeHtml(e.text)}</pre></div>`,
        )
        .join(""),
    );
  }

  // Opening a mesh row in a client. Both answer only for the agent-link id
  // namespace and otherwise fall through to the real session routes.
  const detail = path.match(SESSION_DETAIL);
  if (detail) {
    const sessionId = peerSessionId(detail[1]);
    if (sessionId) {
      const rowId = decodeURIComponent(detail[1]);
      const row = (await externalSessionRows()).find((r) => r.id === rowId);
      // A peer that has exited is gone, not archived: say 404 rather than
      // inventing a row the client would render as a live session.
      if (!row) return Response.json({ error: "Not found" }, { status: 404 });
      // The list marks rows slim, which is what makes a client hydrate one
      // before opening it. The hydrated copy must not repeat the claim or the
      // client re-fetches this same row forever.
      return Response.json({ ...row, slim: false });
    }
  }

  const sessionTranscript = path.match(SESSION_TRANSCRIPT);
  if (sessionTranscript) {
    const sessionId = peerSessionId(sessionTranscript[1]);
    if (sessionId) {
      const entries = await readPeerClientTranscript(sessionId);
      // An empty transcript is a real answer (a peer that has not run a turn);
      // a missing session file is not.
      return Response.json(entries ?? []);
    }
  }

  return undefined;
}
