/**
 * The two halves a scenario freezes, projected into readable shapes.
 *
 * `transcriptView` is what the run WROTE: the unified entries the owned store
 * holds for the session, in seq order.
 *
 * `engineCallView` + `enginePolicyView` are what the run HANDED THE ENGINE. The
 * engine seam is `__setEngineForTest` (agent-runner's EngineRunner), so a
 * scenario sees the fully assembled RunAgentOpts: the prompt with its
 * `<opensession:context>` fences intact, the per-session note (repos + memory),
 * the MCP scope, the tool denials.
 *
 * WHY THE POLICY IS PROJECTED, NOT OBSERVED: the last mile (resolving that
 * scope into mounted MCP servers, and the denials into stripped tool ids)
 * happens inside the opencode adapter, which spawns `opencode serve` and can
 * never run hermetically. So `enginePolicyView` calls the adapter's OWN policy
 * functions (opencode-policy.ts: opencodeGateReason, opencodeRunPolicy,
 * buildOpencodeMcpConfig, sharedOpencodeEligible) on the recorded opts, in the
 * same order and with the same arguments runOpencode passes them. That is real
 * production code deciding the answer; only the caller is the harness. Keep it
 * in step with opencode-runner.ts if that call site changes. The comment
 * beside each call names the line it mirrors.
 */
import type { RunAgentOpts } from "../agent-runner";
import type { TranscriptEntry } from "../types";
import {
  buildOpencodeMcpConfig,
  opencodeGateReason,
  opencodeRunPolicy,
  sharedOpencodeEligible,
} from "../opencode-policy";
import {
  parseContextBlocks,
  stripContext,
  type ContextSource,
} from "../prompt-context";
import type { FakeCall } from "./fake-engine";

// ── What the model was sent ──────────────────────────────────────────────────

export interface PromptView {
  /** What the transcript renders: the prompt minus every fenced block. */
  visible: string;
  /** Each fenced block, in order, with the source it declared. */
  injectedContext: Array<{ source: ContextSource; body: string }>;
}

/** Split a prompt into the human's message and the fenced injections, through
 *  the same reader the context log uses. */
export function promptView(prompt: string): PromptView {
  return {
    visible: stripContext(prompt).trim(),
    injectedContext: parseContextBlocks(prompt),
  };
}

export function engineCallView(call: FakeCall) {
  const opts = call.opts;
  return {
    model: call.model,
    // Whether this turn continues the engine's own session or starts fresh.
    // A handoff note exists to compensate for the second case.
    resumesEngineSession: !!opts.sessionId,
    journalKind: opts.journal?.kind,
    mode: opts.mode,
    user: opts.user,
    mcpScope: opts.mcpServers,
    inProcessMcp: Object.keys(opts.inProcessMcp || {}).sort(),
    deniedTools: Object.keys(opts.deniedTools || {}).sort(),
    confirmTools: Object.keys(opts.confirmTools || {}).sort(),
    prompt: promptView(opts.prompt),
    // The system-prompt note (repos/branch discipline + injected memory).
    sessionNote: opts.reposNote ?? null,
    seedTranscriptEntries: opts.seedTranscriptEntries?.length ?? 0,
    images: opts.images?.length ?? 0,
  };
}

// ── What the adapter would do with it ────────────────────────────────────────

export function enginePolicyView(call: FakeCall) {
  const opts = call.opts;
  // opencode-runner.ts: the run gate, then the shared-vs-per-session server
  // decision, then the MCP projection for whichever kind of server this is.
  const gateReason = opencodeGateReason(opts);
  const shared = sharedOpencodeEligible({
    journal: opts.journal,
    mcpServers: opts.mcpServers,
    user: opts.user,
    mcpGrantUser: opts.mcpGrantUser,
    inProcessMcp: opts.inProcessMcp,
  });
  // Mirrors `buildOpencodeMcpConfig(shared ? "all" : mcpServers, user,
  // [opts.mcpGrantUser, user])`. A shared server's config is multi-session, so
  // an allowlisted run necessarily lands on a per-session server.
  const { mcp } = buildOpencodeMcpConfig(
    shared ? "all" : opts.mcpServers,
    opts.user,
    [opts.mcpGrantUser, opts.user],
  );
  const policy = opencodeRunPolicy({
    deniedTools: opts.deniedTools,
    confirmTools: opts.confirmTools,
    journalKind: opts.journal?.kind,
    disableLocalWorkspaceTools: opts.disableLocalWorkspaceTools,
  });
  return {
    gateReason,
    sharedServerEligible: shared,
    unattended: policy.unattended,
    mountedMcpServers: Object.keys(mcp).sort(),
    mcpConfig: mcp,
    strippedTools: Object.keys(policy.disables).sort(),
    toolStripNotes: policy.noteGroups.map((g) => ({
      tools: [...g.tools].sort(),
      message: g.message,
    })),
  };
}

// ── What the run wrote ───────────────────────────────────────────────────────

/** One stored entry, minus the fields that are a clock or a random id. */
export function transcriptEntryView(entry: TranscriptEntry) {
  return {
    seq: entry.seq,
    type: entry.type,
    // What KIND of row this is, for the two the pipeline writes about itself:
    // an injected payload and a standing-context record read as ordinary
    // system entries otherwise, and a fixture that cannot tell them apart
    // cannot show a regression in either.
    ...(entry.noticeKind ? { noticeKind: entry.noticeKind } : {}),
    ...(entry.contextInjection ? { contextSource: entry.contextInjection.source } : {}),
    content: entry.content,
    ...(entry.toolName ? { toolName: entry.toolName } : {}),
    ...(entry.toolInput !== undefined ? { toolInput: entry.toolInput } : {}),
    ...(entry.isError ? { isError: true } : {}),
    ...(entry.model ? { model: entry.model } : {}),
    ...(entry.images?.length ? { images: entry.images.length } : {}),
  };
}

export function transcriptView(entries: TranscriptEntry[]) {
  return entries.map(transcriptEntryView);
}
