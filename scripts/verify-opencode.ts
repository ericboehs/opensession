#!/usr/bin/env bun
/**
 * Manual verification for the OpenCode engine (docs/sandboxes-plan.md,
 * Workstream E). Starts a scratch opencode session in a throwaway directory
 * via runOpencode — never touches real user sessions, and passes no journal
 * so the shared active-runs journal is never written.
 *
 * Usage:
 *   bun scripts/verify-opencode.ts [opencode/<provider>/<model>] [prompt]
 *
 * Model resolution:
 *   1. argv model, if given.
 *   2. opencode/anthropic/claude-haiku-4-5 when the Anthropic bridge is
 *      enabled (~/.backstage-opencode.json, or a test config via
 *      BACKSTAGE_OPENCODE_CONFIG) — this exercises the full bridge path.
 *   3. Otherwise exits with instructions (an API-key provider needs
 *      `opencode auth login` first).
 *
 * To verify the bridge without enabling it globally:
 *   BACKSTAGE_OPENCODE_CONFIG=/tmp/oc.json bun scripts/verify-opencode.ts
 *   with /tmp/oc.json = {"enabled":true,"bridgeAccountIds":["<account id>"]}
 *   (account ids: jq '.accounts[]|{id,name}' ~/.backstage-claude-accounts.json)
 */

import { existsSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  runOpencode,
  killAllOpencodeServers,
  OPENCODE_BIN,
} from "../src/server/opencode-runner";
import { readOpencodeBridgeConfig } from "../src/server/opencode-config";

const argModel = process.argv[2];
const prompt = process.argv[3] || "Reply with exactly: OK";

const bridgeCfg = readOpencodeBridgeConfig();
const model =
  argModel || (bridgeCfg?.enabled ? "opencode/anthropic/claude-haiku-4-5" : "");

if (!existsSync(OPENCODE_BIN)) {
  console.error(`FAIL: opencode binary not found at ${OPENCODE_BIN}`);
  process.exit(1);
}
console.log(`opencode: ${OPENCODE_BIN} (${Bun.spawnSync([OPENCODE_BIN, "--version"]).stdout.toString().trim()})`);

if (!model) {
  console.error(
    "No model to verify: pass one (bun scripts/verify-opencode.ts opencode/<provider>/<model>)\n" +
      "or enable the Anthropic bridge (see header comment). API-key providers need `opencode auth login`."
  );
  process.exit(1);
}

const cwd = mkdtempSync(join(tmpdir(), "verify-opencode-"));
console.log(`model: ${model}\ncwd:   ${cwd}\nbridge: ${bridgeCfg?.enabled ? `enabled (accounts: ${bridgeCfg.bridgeAccountIds?.length || 0})` : "disabled"}\n`);

let sawDone = false;
let sawError: string | undefined;
try {
  for await (const ev of runOpencode(
    { prompt, cwd, mode: "ask", mcpServers: [] },
    model
  )) {
    const line = JSON.stringify(ev);
    console.log(line.length > 500 ? line.slice(0, 500) + "…" : line);
    if (ev.type === "done") sawDone = true;
    if (ev.type === "error") sawError = ev.content;
  }
} finally {
  killAllOpencodeServers("verify done");
}

if (sawDone && !sawError) {
  console.log("\nPASS: opencode run completed");
  process.exit(0);
}
console.error(`\nFAIL: ${sawError || "run ended without a done event"}`);
process.exit(1);
