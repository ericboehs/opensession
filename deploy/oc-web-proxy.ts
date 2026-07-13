/**
 * oc-web-proxy — expose the opencode web UI at https://oc.tella.dev (tailnet-only,
 * fronted by Caddy exactly like os.tella.dev).
 *
 * Every `opencode serve` process OpenSession spawns already serves the full
 * opencode web app at `/` behind HTTP basic-auth (`opencode:<password>`). This
 * proxy is a thin front that:
 *   - reads OpenSession's live server registry
 *     (~/.opensession-opencode-servers.json),
 *   - picks a healthy, long-lived *shared* server (preferring Michiel's
 *     anthropic pool), sticking to it while it stays alive,
 *   - injects that server's rotating basic-auth so the browser never needs it,
 *   - proxies plain HTTP, SSE (`/event`), and WebSocket (the web terminal).
 *
 * It owns no opencode state of its own — it just routes onto a server the main
 * app already keeps warm (so real model auth via the Meridian bridge works and
 * every session in opencode.db is visible). If the chosen server rotates away,
 * the next request re-picks another live one; all shared servers back the same
 * opencode.db, so the session list is stable across a re-pick.
 *
 * Bound to 127.0.0.1 only; reachability is entirely Caddy's tailnet `bind`.
 */
import { readFileSync } from "node:fs";

const REGISTRY = `${process.env.HOME}/.opensession-opencode-servers.json`;
const PORT = Number(process.env.OC_WEB_PROXY_PORT || 3854);
const HOST = "127.0.0.1";

type Server = {
  url: string;
  password: string;
  key: string;
  shared?: boolean;
  cwd?: string;
};

function authHeader(s: Server): string {
  return `Basic ${Buffer.from(`opencode:${s.password}`).toString("base64")}`;
}

function loadServers(): Server[] {
  try {
    const raw = JSON.parse(readFileSync(REGISTRY, "utf8"));
    return Array.isArray(raw) ? (raw as Server[]) : [];
  } catch {
    return [];
  }
}

/** Higher = more preferred: long-lived shared anthropic servers, Michiel's first. */
function rank(s: Server): number {
  let score = 0;
  if (s.shared) score += 8;
  const key = (s.key || "").toLowerCase();
  if (key.includes("ut41l6gcc")) score += 5; // Michiel's slack id
  if (key.startsWith("shared:anthropic")) score += 3;
  // deprioritise per-automation servers (short-lived, may vanish mid-session)
  if (key.includes("automation")) score -= 6;
  return score;
}

async function healthy(s: Server): Promise<boolean> {
  try {
    const r = await fetch(`${s.url}/doc`, {
      headers: { Authorization: authHeader(s) },
      signal: AbortSignal.timeout(1500),
    });
    return r.ok;
  } catch {
    return false;
  }
}

let sticky: Server | null = null;

async function pickServer(): Promise<Server | null> {
  const servers = loadServers();
  if (sticky) {
    const still = servers.find(
      (s) => s.url === sticky!.url && s.password === sticky!.password,
    );
    if (still && (await healthy(still))) return still;
    sticky = null;
  }
  const ranked = [...servers].sort((a, b) => rank(b) - rank(a));
  for (const s of ranked) {
    if (await healthy(s)) {
      sticky = s;
      return s;
    }
  }
  return null;
}

type WsData = {
  wsUrl: string;
  auth: string;
  up?: WebSocket;
  buf: (string | Uint8Array)[];
};

const server = Bun.serve<WsData, {}>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // long-lived SSE/WS; never idle-close
  async fetch(req) {
    const target = await pickServer();
    if (!target) {
      return new Response("No live opencode server available yet — try again in a moment.", {
        status: 503,
      });
    }
    const inUrl = new URL(req.url);
    const auth = authHeader(target);

    // WebSocket upgrade (opencode web terminal).
    if ((req.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      const wsUrl = `${target.url.replace(/^http/, "ws")}${inUrl.pathname}${inUrl.search}`;
      const ok = server.upgrade(req, { data: { wsUrl, auth, buf: [] } });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    // Plain HTTP / SSE — stream through, swapping in the auth header.
    const headers = new Headers(req.headers);
    headers.set("Authorization", auth);
    headers.delete("host");
    headers.delete("accept-encoding"); // avoid double-encoding surprises on stream
    const upstream = `${target.url}${inUrl.pathname}${inUrl.search}`;
    const method = req.method.toUpperCase();
    const resp = await fetch(upstream, {
      method: req.method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : req.body,
      redirect: "manual",
      // @ts-expect-error Bun/undici streaming request bodies
      duplex: "half",
      signal: req.signal,
    });
    const outHeaders = new Headers(resp.headers);
    outHeaders.delete("content-encoding");
    outHeaders.delete("content-length");
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.statusText,
      headers: outHeaders,
    });
  },
  websocket: {
    idleTimeout: 0,
    open(ws) {
      const up = new WebSocket(ws.data.wsUrl, {
        // Bun supports custom headers on the client WebSocket.
        headers: { Authorization: ws.data.auth },
      } as any);
      up.binaryType = "arraybuffer";
      ws.data.up = up;
      up.onopen = () => {
        for (const m of ws.data.buf) up.send(m as any);
        ws.data.buf = [];
      };
      up.onmessage = (e: MessageEvent) => {
        try {
          ws.send(e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : e.data);
        } catch {}
      };
      up.onclose = () => {
        try {
          ws.close();
        } catch {}
      };
      up.onerror = () => {
        try {
          ws.close();
        } catch {}
      };
    },
    message(ws, msg) {
      const up = ws.data.up;
      if (up && up.readyState === WebSocket.OPEN) up.send(msg as any);
      else ws.data.buf.push(msg);
    },
    close(ws) {
      try {
        ws.data.up?.close();
      } catch {}
    },
  },
});

console.log(`[oc-web-proxy] listening on http://${HOST}:${PORT} -> live opencode server (registry: ${REGISTRY})`);
