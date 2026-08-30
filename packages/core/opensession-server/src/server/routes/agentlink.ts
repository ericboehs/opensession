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
import { readPeerTranscript } from "../../agents/agentlink/transcript";

const TRANSCRIPT_API = /^\/api\/agentlink\/peers\/([^/]+)\/transcript$/;
const TRANSCRIPT_VIEW = /^\/agentlink\/peer\/([^/]+)$/;

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

  return undefined;
}
