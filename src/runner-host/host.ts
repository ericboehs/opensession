/**
 * Run host — a standalone bun process that owns ONE agent run, so the run (and
 * its Claude/Codex CLI child) survives backstage restarts.
 *
 * Spawned by src/server/host-client.ts as a transient systemd unit (escaping
 * the backstage.service cgroup — see spawn there for the IMDS deny and env).
 * Usage: bun run src/runner-host/host.ts <host-dir>/spec.json
 *
 * The host serves a unix socket in its dir; backstage connects as a client and
 * gets live StreamEvents, ask requests (AskUserQuestion / Stripe confirms), and
 * the end signal. Steer/interrupt/cancel come back over the same socket. If no
 * client is attached (backstage restarting), the run keeps going: events are
 * simply not observed live (the transcript jsonl is the durable copy), asks
 * wait until a client reattaches, and the terminal state lands in meta.json so
 * a rebooting backstage can finish the bookkeeping even if this process is gone.
 *
 * The run journal is redirected to a per-host file (BACKSTAGE_RUN_JOURNAL) so
 * concurrent hosts never read-modify-write the shared active-runs.json.
 */

import { dirname, resolve } from "path";

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: bun run host.ts <host-dir>/spec.json");
  process.exit(2);
}
const hostDir = dirname(resolve(specPath));

// Must be set before claude-runner is evaluated — it resolves the journal path
// at module load. The transient unit sets it too; this is the belt-and-braces
// for manual/debug launches. (agent-runner is imported dynamically below so
// this assignment reliably happens first.)
process.env.BACKSTAGE_RUN_JOURNAL ||= `${hostDir}/journal.json`;

const { runAgent, cancelAgentRun, steerAgentRun, interruptAndSteerAgentRun } =
  await import("../server/agent-runner");
const { readFileSync, writeFileSync, existsSync, unlinkSync } = await import("fs");
const { writeJsonAtomic } = await import("../server/shared/atomic-write");
const {
  ndjsonReader,
  HOST_SOCK_NAME,
  HOST_META_NAME,
  BUN_BIN,
  MCP_PROXY_ENTRY,
  rpcSocketPath,
} = await import("./protocol");
const { BACKSTAGE_CHATS_DIR } = await import("../server/paths");

type RunHostSpec = import("./protocol").RunHostSpec;
type RunHostMeta = import("./protocol").RunHostMeta;
type HostToClientMsg = import("./protocol").HostToClientMsg;
type ClientToHostMsg = import("./protocol").ClientToHostMsg;
type AskResult = import("./protocol").AskResult;
type StreamEvent = import("../server/claude-runner").StreamEvent;

const spec: RunHostSpec = JSON.parse(readFileSync(specPath, "utf-8"));
const sockPath = `${hostDir}/${HOST_SOCK_NAME}`;
const metaPath = `${hostDir}/${HOST_META_NAME}`;

const meta: RunHostMeta = {
  hostId: spec.hostId,
  pid: process.pid,
  bksSessionId: spec.bksSessionId,
  startedAt: new Date().toISOString(),
};
const saveMeta = () => writeJsonAtomic(metaPath, meta);
saveMeta();

const log = (...args: unknown[]) =>
  console.log(`[host ${spec.hostId.slice(0, 11)}]`, ...args);

// ── Socket server (single client: the backstage process) ─────────────────────

let client: any = null; // Bun socket of the currently attached backstage
let ended = false;
let terminal: StreamEvent | undefined;
let shutdownAcked: (() => void) | null = null;

const pendingAsks = new Map<
  string,
  { input: Record<string, unknown>; resolve: (r: AskResult) => void }
>();

function send(msg: HostToClientMsg): void {
  if (!client) return;
  try {
    client.write(JSON.stringify(msg) + "\n");
  } catch (e) {
    log("send failed:", e);
  }
}

function sendHello(): void {
  send({
    t: "hello",
    hostId: spec.hostId,
    pid: process.pid,
    bksSessionId: spec.bksSessionId,
    engineSessionId: meta.engineSessionId,
    state: ended ? "ended" : "running",
    pendingAsks: [...pendingAsks.entries()].map(([askId, a]) => ({
      askId,
      input: a.input,
    })),
    done: ended ? terminal : undefined,
  });
}

function handleClientMsg(msg: ClientToHostMsg): void {
  switch (msg.t) {
    case "ask_answer": {
      const ask = pendingAsks.get(msg.askId);
      if (ask) {
        pendingAsks.delete(msg.askId);
        ask.resolve(msg.result);
      }
      break;
    }
    case "steer": {
      if (!steerAgentRun([spec.bksSessionId, meta.engineSessionId], msg.text)) {
        // Too late (run finishing) or backend can't steer — bounce it back so
        // backstage queues it instead of the message evaporating.
        send({ t: "steer_failed", text: msg.text });
      }
      break;
    }
    case "interrupt_steer": {
      if (
        !interruptAndSteerAgentRun(
          [spec.bksSessionId, meta.engineSessionId],
          msg.text
        ) &&
        !steerAgentRun([spec.bksSessionId, meta.engineSessionId], msg.text)
      ) {
        send({ t: "steer_failed", text: msg.text });
      }
      break;
    }
    case "cancel": {
      log("cancel requested");
      cancelAgentRun(spec.bksSessionId, meta.engineSessionId);
      break;
    }
    case "shutdown": {
      shutdownAcked?.();
      break;
    }
  }
}

if (existsSync(sockPath)) unlinkSync(sockPath); // stale socket from a crashed twin
Bun.listen({
  unix: sockPath,
  socket: {
    open(socket) {
      if (client) {
        try {
          client.end();
        } catch {}
      }
      client = socket;
      (socket as any).__read = ndjsonReader(handleClientMsg, "host");
      log("backstage attached");
      sendHello();
    },
    data(socket, data) {
      (socket as any).__read?.(data);
    },
    close(socket) {
      if (client === socket) {
        client = null;
        log("backstage detached");
      }
    },
    error(socket, error) {
      log("socket error:", error);
    },
  },
});
log(`listening on ${sockPath}`);

// ── Ask proxy: block the run on a human answer delivered over the socket ─────
// No timeout here — the timeout/Slack-escalation policy lives in backstage's
// makeAskHandler. If backstage restarts mid-ask, the fresh process gets the
// pending asks in `hello` and re-runs its handler for each.
function onAskUser(input: Record<string, unknown>): Promise<AskResult> {
  const askId = crypto.randomUUID();
  return new Promise<AskResult>((resolvePromise) => {
    pendingAsks.set(askId, { input, resolve: resolvePromise });
    send({ t: "ask", askId, input });
  });
}

// ── mcp-proxy config for the michael-* servers ───────────────────────────────
// Each named server becomes a stdio MCP proxy that forwards tools/list +
// tools/call to backstage over its RPC socket — so session-control/self-admin
// tools keep working across backstage restarts (calls retry while it's down).
function proxyMcpConfigs(): Record<string, unknown> | undefined {
  const names = spec.proxyMcpServers || [];
  if (!names.length || !spec.rpcToken) return undefined;
  const out: Record<string, unknown> = {};
  for (const name of names) {
    out[name] = {
      command: BUN_BIN,
      args: ["run", MCP_PROXY_ENTRY],
      env: {
        BKS_RPC_SOCKET: rpcSocketPath(BACKSTAGE_CHATS_DIR),
        BKS_RPC_TOKEN: spec.rpcToken,
        BKS_MCP_SERVER: name,
      },
    };
  }
  return out;
}

// ── Drive the run ─────────────────────────────────────────────────────────────

process.on("SIGTERM", () => {
  // A deliberate `systemctl stop` of this unit: the child dies with us; the
  // journal file survives, so backstage's boot sweep resumes the run.
  log("SIGTERM — exiting (journal remains for resume)");
  process.exit(143);
});

try {
  for await (const event of runAgent({
    prompt: spec.prompt,
    sessionId: spec.engineSessionId || undefined,
    cwd: spec.cwd,
    mode: spec.mode,
    model: spec.model,
    images: spec.images,
    forkSession: spec.forkSession,
    resumeSessionAt: spec.resumeSessionAt,
    mcpServers: spec.mcpServers,
    inProcessMcp: proxyMcpConfigs(),
    reposNote: spec.reposNote,
    deniedTools: spec.deniedTools,
    confirmTools: spec.confirmTools,
    aws: spec.aws,
    author: spec.author,
    user: spec.user,
    fallbackModel: spec.fallbackModel,
    journal: { bksSessionId: spec.bksSessionId, kind: spec.journalKind || "prompt" },
    onAskUser,
  })) {
    if (event.type === "init" && event.sessionId) {
      meta.engineSessionId = event.sessionId;
      saveMeta();
    }
    if (event.type === "done" || event.type === "error") terminal = event;
    send({ t: "event", event });
  }
} catch (e: any) {
  log("run threw:", e);
  terminal = { type: "error", content: e?.message || String(e) };
  send({ t: "event", event: terminal });
}

ended = true;
meta.done = terminal ?? { type: "error", content: "Run ended without a result" };
meta.endedAt = new Date().toISOString();
saveMeta();
send({ t: "end", done: terminal });
log("run ended:", terminal?.type || "no-terminal");

// Linger for the client's shutdown ack (or a late reattach that consumes the
// end state). If nobody comes, exit anyway — meta.done lets the boot sweep
// finish the bookkeeping without us.
await new Promise<void>((resolveWait) => {
  shutdownAcked = resolveWait;
  setTimeout(resolveWait, 5 * 60_000);
});

try {
  unlinkSync(sockPath);
} catch {}
log("exiting");
process.exit(0);
