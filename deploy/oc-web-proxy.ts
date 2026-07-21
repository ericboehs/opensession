/**
 * oc-web-proxy — expose the opencode web UI at https://oc.tella.dev (tailnet-only,
 * fronted by Caddy exactly like os.tella.dev).
 *
 * Every `opencode serve` process serves the full opencode web app at `/` behind
 * HTTP basic-auth (`opencode:<password>`). This proxy is a thin front that:
 *   - targets ONE dedicated, persistent server (oc-web-server.service on :3855),
 *   - injects its basic-auth so the browser never needs a password,
 *   - proxies plain HTTP, SSE (`/event`), and WebSocket (the web terminal).
 *
 * Why a dedicated server instead of an existing pooled one: opencode partitions
 * its storage per bridge account / run kind. The shared interactive pool sits on
 * an ISOLATED datastore (only scratch/test sessions), and the per-session bks-*
 * servers that DO back the main db (`~/.local/share/opencode`, where every real
 * backstage session lives) are ephemeral. oc-web-server.service is a stable
 * `opencode serve` pinned to that main db, so the web UI shows all real backstage
 * sessions and the target never rotates out from under us.
 *
 * Caveat: that dedicated server has no Meridian/OpenAI bridge auth, so the web UI
 * is effectively browse/read-only — starting a brand-new model turn from it will
 * fail auth. Drive sessions from the OpenSession UI; use this to inspect them.
 *
 * Config via env (see ~/.opensession-ocweb.env):
 *   OC_WEB_TARGET            upstream base url  (default http://127.0.0.1:3855)
 *   OPENCODE_SERVER_PASSWORD upstream basic-auth password
 *   OC_WEB_PROXY_PORT        listen port        (default 3854)
 *
 * Bound to 127.0.0.1 only; reachability is entirely Caddy's tailnet `bind`.
 */

const TARGET = (process.env.OC_WEB_TARGET || "http://127.0.0.1:3855").replace(/\/$/, "");
const PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || "";
const PORT = Number(process.env.OC_WEB_PROXY_PORT || 3854);
const HOST = "127.0.0.1";

const AUTH = `Basic ${Buffer.from(`opencode:${PASSWORD}`).toString("base64")}`;

type WsData = {
  wsUrl: string;
  up?: WebSocket;
  buf: (string | Uint8Array)[];
};

const server: Bun.Server<WsData> = Bun.serve<WsData>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 0, // long-lived SSE/WS; never idle-close
  async fetch(req): Promise<Response | undefined> {
    const inUrl = new URL(req.url);

    // WebSocket upgrade (opencode web terminal).
    if ((req.headers.get("upgrade") || "").toLowerCase() === "websocket") {
      const wsUrl = `${TARGET.replace(/^http/, "ws")}${inUrl.pathname}${inUrl.search}`;
      const ok: boolean = server.upgrade(req, { data: { wsUrl, buf: [] } });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    // Plain HTTP / SSE — stream through, swapping in the auth header.
    const headers = new Headers(req.headers);
    headers.set("Authorization", AUTH);
    headers.delete("host");
    headers.delete("accept-encoding"); // avoid double-encoding surprises on stream
    const upstream = `${TARGET}${inUrl.pathname}${inUrl.search}`;
    const method = req.method.toUpperCase();
    let resp: Response;
    try {
      resp = await fetch(upstream, {
        method: req.method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : req.body,
        redirect: "manual",
        // @ts-expect-error Bun/undici streaming request bodies
        duplex: "half",
        signal: req.signal,
      });
    } catch {
      return new Response("opencode web server unavailable — try again in a moment.", {
        status: 502,
      });
    }
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
        headers: { Authorization: AUTH },
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

console.log(`[oc-web-proxy] listening on http://${HOST}:${PORT} -> ${TARGET}`);
