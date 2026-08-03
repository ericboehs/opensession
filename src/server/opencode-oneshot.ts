/**
 * Single-prompt helper on the opencode engine — the replacement for the old
 * direct Claude-SDK `query()` one-shots (titles, branch names, intent/spam
 * classifiers, note edits, schedule parsing...).
 *
 * Shape: one shared tool-less `opencode serve` per provider (pooled through
 * opencode-runner's server pool, so config-hash reuse, idle reaping and
 * shutdown kills all apply), one throwaway opencode session per call, the
 * synchronous /session/:id/message endpoint (no SSE pump), per-prompt
 * `system` + `tools: {"*": false}` overrides so the shared server's config —
 * and therefore the server itself — never varies by call site.
 *
 * Fail-soft: returns null on ANY failure (bridge off, no usable account,
 * timeout, provider error). Every call site treats null as "skip / fall
 * back", exactly like the old SDK one-shots did. Claude usage limits rotate
 * the meridian account once (model-scoped markExhausted + re-pick) before
 * giving up.
 */
import { mkdirSync } from "fs";
import {
  ensureOpencodeServer,
  peekOpencodeServer,
  releaseOpencodeServer,
  clientFor,
  parseOpencodeModel,
  meridianStackInfo,
  meridianAccountEnv,
  meridianProxyBaseUrl,
  ensureLocalMeridianReady,
  pickMeridianAccount,
  OPENCODE_STATE_DIR,
  type OpencodeServerEntry,
} from "./opencode-runner";
import { readOpencodeBridgeConfig, opencodeProviderOptions } from "./opencode-config";
import { ensureAnthropicBridge } from "./anthropic-bridge";
import { isClaudeUsageLimitError } from "./runner-shared";
import { markExhausted, getUsableAccountById, type ClaudeAccount } from "./claude-accounts";
import { localProfileDefaultModel, toOpencodeModel } from "./models";
import { envAlias } from "./rename-compat";
import { audit } from "./audit";
import { isLocalProfile } from "./profile";
import { bindOpenaiAccount, pickOpenaiAccount } from "./opencode-openai-auth";
import { localOpencodeDataRoot, localProviderError } from "./local-engine-auth";

const DEFAULT_ONESHOT_MODEL = "opencode/anthropic/claude-haiku-4-5";
const DEFAULT_TIMEOUT_MS = 120_000;
const ONESHOT_CWD = `${OPENCODE_STATE_DIR}/oneshot`;

export interface OneShotOpts {
  /** System prompt for the call (per-prompt channel — not server config). */
  system?: string;
  /**
   * Model id — opencode/<provider>/<model> or a native id (mapped through
   * toOpencodeModel, so per-site env vars holding "claude-haiku-4-5" keep
   * working). Default: OPENSESSION_ONESHOT_MODEL or opencode haiku.
   */
  model?: string;
  /** Run user — personal-first meridian account pick, same as full runs. */
  user?: string;
  /** Call-site label for the audit log (e.g. "generated-titles"). */
  label?: string;
  timeoutMs?: number;
}

// Serialize ensure calls per server key so concurrent one-shots (titles +
// intent classifiers often fire together) don't double-spawn a server.
const ensureChains: Map<string, Promise<unknown>> = ((globalThis as any)
  .__oneshotEnsureChains ??= new Map());

// Sticky meridian account per server key: pickAccount round-robins accounts
// in the same utilization bucket, and a different account means a different
// env hash — which would respawn the shared server on every call. Reuse the
// last account while it stays usable; rotation still moves off it.
const stickyAccounts: Map<string, string> = ((globalThis as any)
  .__oneshotStickyAccounts ??= new Map());

function ensureSerialized(
  key: string,
  cwd: string,
  config: Record<string, unknown>,
  extraEnv?: Record<string, string>
): Promise<OpencodeServerEntry> {
  const prev = ensureChains.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    // shared: a config change (a different sticky account after a rotation)
    // must DRAIN the old server — in-flight one-shots finish on it — never
    // kill it under them. Before 2026-07-26 this killed mid-request and one
    // title-backfill batch lost 74 calls to "socket connection was closed".
    .then(() => ensureOpencodeServer(key, cwd, config, undefined, extraEnv, { shared: true }));
  ensureChains.set(key, next);
  return next;
}

/** Extract the assistant's text from a completed prompt response. */
function textOf(parts: Array<{ type?: string; text?: string }> | undefined): string {
  return (parts || [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("")
    .trim();
}

function errorText(info: { error?: unknown } | undefined): string {
  const err = info?.error as { name?: string; data?: { message?: string } } | undefined;
  if (!err) return "";
  return `${err.name || "error"}: ${err.data?.message || JSON.stringify(err)}`;
}

/**
 * Run a single prompt, return the model's text — or null on any failure.
 */
export async function opencodeOneShot(
  prompt: string,
  opts: OneShotOpts = {}
): Promise<string | null> {
  // One-shots are real model calls on a real engine server — never from bun
  // test (title/branch-name callers all tolerate null and fall back).
  if (process.env.NODE_ENV === "test") return null;
  const localProfile = isLocalProfile();
  const requested = localProfile
    ? envAlias("OPENSESSION_ONESHOT_MODEL", "BACKSTAGE_ONESHOT_MODEL") ||
      `opencode/${localProfileDefaultModel()}`
    : opts.model ||
      envAlias("OPENSESSION_ONESHOT_MODEL", "BACKSTAGE_ONESHOT_MODEL") ||
      DEFAULT_ONESHOT_MODEL;
  const model = toOpencodeModel(requested) || requested;
  const parsed = parseOpencodeModel(model);
  const label = opts.label || "oneshot";
  if (!parsed) {
    // Native id that toOpencodeModel didn't map (anthropic bridge disabled) —
    // there is no other engine anymore, so this is a hard skip.
    console.warn(`[oneshot:${label}] model "${requested}" doesn't resolve to an opencode id — skipping`);
    return null;
  }
  if (localProfile) {
    const localAuthError = localProviderError(parsed.providerID);
    if (localAuthError) {
      console.warn(`[oneshot:${label}] ${localAuthError} — skipping`);
      return null;
    }
  }

  const startedAt = Date.now();
  const serverKey = localProfile
    ? `oneshot:local:${parsed.providerID}`
    : `oneshot:${parsed.providerID}`;
  // Two attempts max: an unhealthy meridian account (a usage limit, or a wedged
  // subscription/provider fault that only ever reaches us as our own 120s
  // timeout — opencode swallows the real error into an internal retry loop) is
  // sidelined and re-picked once; anything else fails immediately.
  for (let attempt = 0; attempt < 2; attempt++) {
    let account: ClaudeAccount | undefined;
    try {
      // Provider auth: meridian (or native bridge) for anthropic models —
      // same dispatch as full runs; other providers use opencode's own auth.
      let providerOverride: Record<string, unknown> | undefined;
      let extraEnv: Record<string, string> | undefined;
      let plugin: string[] | undefined;
      if (parsed.providerID === "anthropic") {
        const cfg = readOpencodeBridgeConfig();
        const bridgeMode = cfg?.enabled ? cfg.bridgeMode : "off";
        if (bridgeMode === "meridian") {
          const stack = meridianStackInfo();
          const stickyId = stickyAccounts.get(serverKey);
          const sticky =
            stickyId && (!cfg!.bridgeAccountIds?.length || cfg!.bridgeAccountIds.includes(stickyId))
              ? getUsableAccountById(stickyId, parsed.modelID)
              : undefined;
          const picked =
            sticky ?? pickMeridianAccount(opts.user, parsed.modelID, cfg!.bridgeAccountIds);
          if ("error" in picked) throw new Error(`meridian bridge: ${picked.error}`);
          account = picked;
          stickyAccounts.set(serverKey, picked.id);
          const meridianKey = peekOpencodeServer(serverKey)?.meridianKey || crypto.randomUUID();
          // Own session store, like every other server key — one-shots are the
          // chattiest client on the box and were a top contender for the shared
          // store's lock contention (see MERIDIAN_SESSION_ROOT).
          const meridianEnv = meridianAccountEnv(picked, meridianKey, serverKey);
          extraEnv = {
            ...meridianEnv,
            ...(localProfile ? { XDG_DATA_HOME: localOpencodeDataRoot("anthropic") } : {}),
          };
          plugin = [stack.pluginPath];
          providerOverride = {
            anthropic: {
              options: {
                baseURL: meridianProxyBaseUrl(meridianEnv.CLAUDE_PROXY_PORT),
                apiKey: meridianKey,
              },
            },
          };
        } else if (bridgeMode === "native") {
          const bridge = ensureAnthropicBridge();
          providerOverride = {
            anthropic: { options: { baseURL: `${bridge.url}/v1`, apiKey: bridge.key } },
          };
        } else {
          console.warn(`[oneshot:${label}] anthropic bridge disabled — skipping`);
          return null;
        }
      } else if (localProfile && parsed.providerID === "openai") {
        const picked = pickOpenaiAccount(parsed.modelID, undefined, serverKey);
        if ("error" in picked) throw new Error(`opencode/openai: ${picked.error}`);
        const bound = bindOpenaiAccount(picked);
        if ("error" in bound) throw new Error(`opencode/openai: ${bound.error}`);
        extraEnv = bound.extraEnv;
        providerOverride = bound.providerOverride;
      }

      mkdirSync(ONESHOT_CWD, { recursive: true });
      // Same merge as full runs: configured third-party providers UNDER the
      // bridge override (anthropic/openai always win); key omitted when both
      // are empty so the no-providers config hash is unchanged.
      const providerConfig = {
        ...(localProfile ? {} : opencodeProviderOptions()),
        ...(providerOverride || {}),
      };
      const config: Record<string, unknown> = {
        mcp: {},
        autoshare: false,
        // Shadow-git snapshots are disabled fleet-wide (see opencode-runner.ts
        // — they saturated the disk 2026-07-27); a tool-less one-shot has
        // nothing to snapshot anyway.
        snapshot: false,
        // Tool-less by construction (belt) + deny-all permissions (suspenders):
        // a one-shot is a pure text transform, never an agent.
        tools: { "*": false },
        permission: { edit: "deny", bash: { "*": "deny" }, webfetch: "deny", external_directory: "deny" },
        ...(plugin ? { plugin } : {}),
        ...(Object.keys(providerConfig).length ? { provider: providerConfig } : {}),
      };

      const entry = await ensureSerialized(serverKey, ONESHOT_CWD, config, extraEnv);
      if (extraEnv?.MERIDIAN_API_KEY) entry.meridianKey = extraEnv.MERIDIAN_API_KEY;
      entry.activeRuns++;
      entry.lastUsed = Date.now();
      const client = clientFor(entry);

      let ocSessionId: string | undefined;
      try {
        const created = await client.session.create({ body: { title: `oneshot ${label}` } });
        if (!created.data) throw new Error(`session create failed: ${JSON.stringify(created.error ?? "")}`);
        ocSessionId = created.data.id;
        if (localProfile && parsed.providerID === "anthropic") {
          await ensureLocalMeridianReady(entry, meridianStackInfo());
        }

        const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const result = await Promise.race([
          client.session.prompt({
            path: { id: ocSessionId },
            body: {
              model: parsed,
              system: opts.system,
              tools: { "*": false },
              parts: [{ type: "text", text: prompt }],
            },
          }),
          new Promise<"timeout">((r) => setTimeout(() => r("timeout"), timeoutMs)),
        ]);

        if (result === "timeout") {
          void client.session.abort({ path: { id: ocSessionId } }).catch(() => {});
          throw new Error(`timed out after ${timeoutMs}ms`);
        }
        if (!result.data) throw new Error(`prompt failed: ${JSON.stringify(result.error ?? "")}`);

        const text = textOf(result.data.parts as any);
        const errText = errorText(result.data.info);
        if (!text && errText) throw new Error(errText);

        audit({
          msg: "opencode_oneshot",
          label,
          model,
          status: "ok",
          duration_ms: Date.now() - startedAt,
          ...(account ? { account: account.name } : {}),
        });
        return text || null;
      } finally {
        releaseOpencodeServer(entry);
        if (ocSessionId) void client.session.delete({ path: { id: ocSessionId } }).catch(() => {});
      }
    } catch (e: any) {
      const message = e?.message || String(e);
      const limited = isClaudeUsageLimitError(message, true);
      // A wedged sticky account must not pin the whole one-shot path to itself.
      // opencode retries a provider fault (a usage limit, or a "Claude Max
      // subscription issue") internally with backoff, so what reaches us is our
      // own 120s timeout, never the underlying error text — that timeout IS the
      // signal the sticky account is unhealthy for one-shots. Treat both a usage
      // limit and that timeout as an account fault: drop the sticky pin, sideline
      // the account for a cooldown so the re-pick routes around it, and retry
      // once on a fresh account. Without this, one broken account silently kills
      // every title/branch/router one-shot until a restart (the 2026-07-14
      // "titles show the raw prompt" wedge).
      const wedged = message.includes("timed out after");
      if (account && (limited || wedged)) {
        if (stickyAccounts.get(serverKey) === account.id) stickyAccounts.delete(serverKey);
        markExhausted(account.id, parsed.modelID);
        if (attempt === 0) {
          console.warn(
            `[oneshot:${label}] ${account.name} unhealthy (${limited ? "usage limit" : "wedged/timeout"}) — rotating account`,
          );
          continue;
        }
      }
      console.warn(`[oneshot:${label}] failed: ${message}`);
      audit({
        msg: "opencode_oneshot",
        label,
        model,
        status: limited ? "usage_limit" : "error",
        error: message.slice(0, 500),
        duration_ms: Date.now() - startedAt,
        // Name the account on the error path too, not just on success (line ~228):
        // a wedged account that broke every one-shot for hours was only
        // identifiable by correlating with the last ok row — logged 2026-07-14.
        ...(account ? { account: account.name } : {}),
      });
      return null;
    }
  }
  return null;
}
