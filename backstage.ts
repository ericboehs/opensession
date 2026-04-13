#!/usr/bin/env bun

import { randomUUIDv7 } from "bun";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "fs";
import homepage from "./src/frontend/index.html";
import { getAllSessions } from "./src/server/sessions";
import { parseTranscript } from "./src/server/jsonl-parser";
import { startWatching, stopAllWatchesForClient } from "./src/server/file-watcher";
import { listWorktrees, createWorktree } from "./src/server/worktree";
import { runClaude, isSessionBusy, cancelRun } from "./src/server/claude-runner";
import type { UnifiedSession, BackstageSessionFile } from "./src/server/types";

const PORT = parseInt(process.env.PORT || "3850");
const HOST = process.env.HOST || "100.65.135.7";
const HOME = process.env.HOME || "/home/ubuntu";
const BACKSTAGE_SESSIONS_DIR = `${HOME}/.backstage-sessions`;

mkdirSync(BACKSTAGE_SESSIONS_DIR, { recursive: true });

// Cache sessions with short TTL
let sessionsCache: { data: UnifiedSession[]; ts: number } | null = null;
const CACHE_TTL = 2000;

function getCachedSessions(): UnifiedSession[] {
  if (sessionsCache && Date.now() - sessionsCache.ts < CACHE_TTL) {
    return sessionsCache.data;
  }
  const data = getAllSessions();
  sessionsCache = { data, ts: Date.now() };
  return data;
}

function findSession(sessionId: string): UnifiedSession | undefined {
  return getCachedSessions().find((s) => s.id === sessionId);
}

// WebSocket client state
interface WSClientData {
  watchingSessionId: string | null;
  activeRunSessionId: string | null;
}

const clientData = new WeakMap<any, WSClientData>();

console.log(`Starting Backstage server on ${HOST}:${PORT}...`);

const server = Bun.serve<WSClientData>({
  port: PORT,
  hostname: HOST,

  routes: {
    "/backstage": homepage,
    "/backstage/": homepage,
    "/backstage/index.html": homepage,
  },

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Client-side routing — serve index.html for /backstage/session/*
    if (path.startsWith("/backstage/session/") || path === "/backstage/new") {
      return new Response(Bun.file("./src/frontend/index.html").stream(), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // Health check
    if (path === "/backstage/api/health") {
      return Response.json({ ok: true, uptime: process.uptime() });
    }

    // List sessions
    if (path === "/backstage/api/sessions" && req.method === "GET") {
      return Response.json(getCachedSessions());
    }

    // Get transcript for a session
    if (path.match(/^\/backstage\/api\/sessions\/(.+)\/transcript$/) && req.method === "GET") {
      const sessionId = decodeURIComponent(path.match(/^\/backstage\/api\/sessions\/(.+)\/transcript$/)![1]);
      const session = findSession(sessionId);
      if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
      if (!session.transcriptPath) return Response.json([]);
      return Response.json(parseTranscript(session.transcriptPath));
    }

    // List worktrees
    if (path === "/backstage/api/worktrees" && req.method === "GET") {
      return Response.json(await listWorktrees());
    }

    // WebSocket upgrade
    if (path === "/backstage/ws") {
      const upgraded = server.upgrade(req, {
        data: { watchingSessionId: null, activeRunSessionId: null },
      });
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return undefined;
    }

    // 404
    return Response.json({ error: "Not found" }, { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log("WebSocket client connected");
    },

    async message(ws, message) {
      let msg: any;
      try {
        msg = JSON.parse(String(message));
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      switch (msg.type) {
        case "watch": {
          const sessionId = msg.sessionId;
          const session = findSession(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
            return;
          }

          // Update client state
          const data = ws.data;
          data.watchingSessionId = sessionId;

          // Send full transcript
          const entries = session.transcriptPath
            ? parseTranscript(session.transcriptPath)
            : [];
          ws.send(JSON.stringify({ type: "transcript_init", entries }));

          // Start file watcher
          if (session.transcriptPath) {
            startWatching(session.transcriptPath, ws);
          }

          // Send running status
          ws.send(
            JSON.stringify({
              type: "session_status",
              isRunning: session.isRunning || isSessionBusy(session.claudeSessionId || ""),
            })
          );
          break;
        }

        case "prompt": {
          const { sessionId, content } = msg;
          const session = findSession(sessionId);
          if (!session) {
            ws.send(JSON.stringify({ type: "error", message: "Session not found" }));
            return;
          }
          if (!session.claudeSessionId) {
            ws.send(JSON.stringify({ type: "error", message: "No Claude session to resume" }));
            return;
          }

          const cwd = session.worktreeDir || `${HOME}/projects/tella-fusion`;

          ws.send(JSON.stringify({ type: "stream_start", sessionId }));

          for await (const event of runClaude({
            prompt: content,
            sessionId: session.claudeSessionId,
            cwd,
          })) {
            switch (event.type) {
              case "init":
                break;
              case "text_chunk":
                ws.send(JSON.stringify({ type: "stream_text", text: event.text }));
                break;
              case "tool_use":
                ws.send(
                  JSON.stringify({
                    type: "stream_tool_use",
                    entry: {
                      id: event.toolUseId || crypto.randomUUID(),
                      type: "tool_use",
                      content: `Using ${event.toolName}`,
                      timestamp: new Date().toISOString(),
                      toolName: event.toolName,
                      toolInput: event.toolInput,
                      toolUseId: event.toolUseId,
                    },
                  })
                );
                break;
              case "tool_result":
                ws.send(
                  JSON.stringify({
                    type: "stream_tool_result",
                    entry: {
                      id: crypto.randomUUID(),
                      type: "tool_result",
                      content: event.content || "",
                      timestamp: new Date().toISOString(),
                      toolUseId: event.toolUseId,
                    },
                  })
                );
                break;
              case "done":
                // Invalidate session cache
                sessionsCache = null;
                break;
              case "error":
                ws.send(JSON.stringify({ type: "error", message: event.content }));
                break;
            }
          }

          ws.send(JSON.stringify({ type: "stream_done" }));
          break;
        }

        case "cancel": {
          const data = ws.data;
          if (data.watchingSessionId) {
            const session = findSession(data.watchingSessionId);
            if (session?.claudeSessionId) {
              cancelRun(session.claudeSessionId);
            }
          }
          break;
        }

        case "create_session": {
          const { branch, prompt, user } = msg;
          try {
            // Check if worktree exists, create if needed
            const worktrees = await listWorktrees();
            let wtPath = worktrees.find((w) => w.branch === branch)?.path;
            if (!wtPath) {
              wtPath = await createWorktree(branch);
            }

            const bksId = `bks-${randomUUIDv7()}`;

            ws.send(JSON.stringify({ type: "stream_start", sessionId: bksId }));

            let claudeSessionId = "";
            for await (const event of runClaude({
              prompt,
              cwd: wtPath,
            })) {
              if (event.type === "init") {
                claudeSessionId = event.sessionId || "";
              }
              if (event.type === "text_chunk") {
                ws.send(JSON.stringify({ type: "stream_text", text: event.text }));
              }
              if (event.type === "done") {
                claudeSessionId = event.sessionId || claudeSessionId;
              }
              if (event.type === "error") {
                ws.send(JSON.stringify({ type: "error", message: event.content }));
              }
            }

            // Save backstage session
            const sessionData: BackstageSessionFile = {
              id: bksId,
              claudeSessionId,
              branch,
              worktreeDir: wtPath,
              createdBy: user || "Anonymous",
              createdAt: new Date().toISOString(),
              lastActivity: new Date().toISOString(),
            };
            writeFileSync(
              `${BACKSTAGE_SESSIONS_DIR}/${bksId}.json`,
              JSON.stringify(sessionData, null, 2)
            );

            sessionsCache = null;
            ws.send(JSON.stringify({ type: "stream_done" }));
            ws.send(JSON.stringify({ type: "session_created", id: bksId }));
          } catch (e: any) {
            ws.send(JSON.stringify({ type: "error", message: e.message || String(e) }));
          }
          break;
        }
      }
    },

    close(ws) {
      stopAllWatchesForClient(ws);
      console.log("WebSocket client disconnected");
    },
  },

  development: {
    hmr: true,
    console: true,
  },
});

console.log(`Backstage running at http://${HOST}:${PORT}/backstage/`);
