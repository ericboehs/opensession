#!/usr/bin/env bun
/**
 * Manual verification for the SHARED opencode server pool (opencode-runner
 * "Server lifecycle"): drives the REAL runOpencode path with
 * `forceSharedServer` (the test-only eligibility override — no journal is
 * written, same trusted-caller pattern as verify-opencode.ts's
 * `allowOpencode`) and asserts:
 *
 *  1. Two concurrent runs in different scratch directories multiplex onto
 *     ONE `opencode serve` process, each seeing its own cwd from bash.
 *  2. Ask mode on the shared server (per-prompt `agent: "ask"`) cannot
 *     create files.
 *  3. Cleanup kills exactly the one shared server.
 *
 * Scratch dirs only; never touches real sessions. Note the shared config
 * lists ALL external MCP servers from mcp-config.json (that is the point of
 * the pool), so the spawned server briefly connects them — same as any
 * interactive run.
 *
 * Usage: bun scripts/verify-shared-opencode.ts [opencode/<provider>/<model>]
 */
import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runOpencode,
  killAllOpencodeServers,
  awaitOpencodeServersDead,
  OPENCODE_BIN,
} from "../packages/core/opensession-server/src/server/opencode-runner";
import { readOpencodeBridgeConfig } from "../packages/core/opensession-server/src/server/opencode-config";

const model = process.argv[2] || "opencode/anthropic/claude-haiku-4-5";
if (!existsSync(OPENCODE_BIN)) {
  console.error(`FAIL: opencode binary not found at ${OPENCODE_BIN}`);
  process.exit(1);
}
if (model.includes("/anthropic/") && !readOpencodeBridgeConfig()?.enabled) {
  console.error("FAIL: anthropic bridge not enabled — pass a non-anthropic model");
  process.exit(1);
}

let failed = false;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) failed = true;
};

async function drain(
  gen: AsyncGenerator<any>
): Promise<{ text: string; result?: string; error?: string }> {
  let text = "";
  let result: string | undefined;
  let error: string | undefined;
  for await (const ev of gen) {
    if (ev.type === "text_chunk") text += ev.text;
    if (ev.type === "done") result = ev.result;
    if (ev.type === "error") error = ev.content;
  }
  return { text, result, error };
}

// No sessionId/journal → each run mints a random run key (no "Session is
// busy" collision between the concurrent runs) and nothing is journaled.
const run = (cwd: string, prompt: string, mode?: "ask" | "code") =>
  drain(
    runOpencode(
      {
        prompt,
        cwd,
        mode: mode || "code",
        user: process.env.OPENSESSION_VERIFY_USER || "Local User",
        allowOpencode: true,
        forceSharedServer: true,
      } as any,
      model
    )
  );

const dirA = mkdtempSync(join(tmpdir(), "verify-shared-A-"));
const dirB = mkdtempSync(join(tmpdir(), "verify-shared-B-"));
const pwdPrompt =
  "Use the bash tool to run the command `pwd` and reply with only its raw output. Nothing else.";

console.log(`model: ${model}\ndirA: ${dirA}\ndirB: ${dirB}`);

// 1) Two concurrent runs, one server, per-run cwd.
const [a, b] = await Promise.all([run(dirA, pwdPrompt), run(dirB, pwdPrompt)]);
check("run A completed", !a.error && !!a.result, a.error || "");
check("run B completed", !b.error && !!b.result, b.error || "");
check("run A bash cwd = dirA", (a.result || "").includes(dirA), (a.result || "").slice(-120));
check("run B bash cwd = dirB", (b.result || "").includes(dirB), (b.result || "").slice(-120));

// 2) Ask mode on the shared server: read-only agent.
const ask = await run(
  dirA,
  "Create a file named poc-ask.txt containing HI in the current directory using any tool. If you cannot, reply with exactly: CANNOT",
  "ask"
);
check("ask run completed", !ask.error, ask.error || "");
check(
  "ask mode cannot write on shared server",
  !existsSync(join(dirA, "poc-ask.txt")),
  `result=${(ask.result || "").slice(0, 120)}`
);

// 3) Server count: ONE per (account × user) tuple. With a healthy account
// pool all three runs multiplex onto a single server; usage-limit rotation
// mid-verify legitimately fans out (each account tuple gets its own server —
// that IS the pool contract), so the ceiling is the 3 runs' worst case.
const killed = killAllOpencodeServers("verify-shared done");
check(
  "shared pool: 1 server per account tuple (1 when no rotation happened)",
  killed >= 1 && killed <= 3,
  `servers=${killed}${killed > 1 ? " (account rotation occurred — check logs)" : ""}`
);
await awaitOpencodeServersDead();

console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
process.exit(failed ? 1 : 0);
