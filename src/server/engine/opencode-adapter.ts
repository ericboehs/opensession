/**
 * OpenCode engine adapter: a typed facade over the existing opencode runner
 * (transcript-v2 design §7). This is a CONFORMANCE MAPPING, not a refactor —
 * every member delegates 1:1 to an already-exported opencode-runner function,
 * so the adapter documents how today's engine satisfies the EngineAdapter
 * contract without touching runner internals (which need a real restart to
 * change; this file is inert until something imports it).
 *
 * Delegation map (all real exports of ../opencode-runner):
 *  - startTurn              → runOpencode(opts, model)   (init-with-sessionId,
 *                             terminal done+TurnUsage / error, usage_snapshot,
 *                             model rotation notices as runner_notice,
 *                             usageLimitExhausted + noticePersisted flags)
 *  - steer                  → steerOpencodeRun (noReply history append the
 *                             running turn picks up at its next step boundary)
 *  - cancel                 → cancelOpencodeRun (aborts the registered
 *                             AbortController for any alias key)
 *  - isBusy                 → isOpencodeSessionBusy (activeRuns alias lookup)
 *  - reattach               → tryReattachOpencodeRun (adopted detached-server
 *                             probe + SSE re-pump + transcript gap backfill)
 *  - activeDetachedRunCount → activeDetachedOpencodeRunCount
 *
 * Note: agent-runner additionally consumes activeOpencodeRunCount() for the
 * graceful-shutdown drain; that lives outside the §7 adapter contract on
 * purpose (it's a process-lifecycle concern, not a per-engine one) and keeps
 * being imported directly.
 */

import type { EngineAdapter } from "./adapter-types";
import {
  runOpencode,
  steerOpencodeRun,
  cancelOpencodeRun,
  isOpencodeSessionBusy,
  tryReattachOpencodeRun,
  activeDetachedOpencodeRunCount,
} from "../opencode-runner";

export const opencodeAdapter: EngineAdapter = {
  name: "opencode",
  startTurn: (opts, model) => runOpencode(opts, model),
  steer: (id, text, images) => steerOpencodeRun(id, text, images),
  cancel: (id) => cancelOpencodeRun(id),
  isBusy: (id) => isOpencodeSessionBusy(id),
  reattach: (run, handlers) => tryReattachOpencodeRun(run, handlers ?? {}),
  activeDetachedRunCount: () => activeDetachedOpencodeRunCount(),
};
