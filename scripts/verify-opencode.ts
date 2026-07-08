#!/usr/bin/env bun
/**
 * Manual verification for the OpenCode engine (docs/sandboxes-plan.md,
 * Workstream E). First empirically asserts the server's Basic-auth is
 * enforced (scratch server, no config), then starts a scratch opencode
 * session in a throwaway directory via runOpencode — never touches real user
 * sessions, and passes no journal so the shared active-runs journal is never
 * written (the explicit `allowOpencode` marker passes the runner's
 * deny-by-default interactive gate instead).
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

// ── Basic-auth enforcement (empirical, every verify run) ─────────────────────
// Verified live 2026-07-08 against opencode 1.17.15: with
// OPENCODE_SERVER_PASSWORD set, `opencode serve` answers GET /app with 401 for
// missing/wrong credentials and 200 for `opencode:<password>` Basic auth —
// i.e. the per-server password opencode-runner mints is actually enforced.
// Re-asserted here on a scratch server so an opencode upgrade that silently
// drops auth fails this script loudly.
async function verifyBasicAuth(): Promise<void> {
  const password = crypto.randomUUID();
  const dir = mkdtempSync(join(tmpdir(), "verify-opencode-auth-"));
  const proc = Bun.spawn({
    cmd: [OPENCODE_BIN, "serve", "--hostname=127.0.0.1", "--port=0"],
    cwd: dir,
    env: {
      PATH: process.env.PATH || "",
      HOME: process.env.HOME || "",
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(
        () => reject(new Error(`auth-check server didn't start in 30s: ${buf.slice(-300)}`)),
        30_000
      );
      const drain = (stream: ReadableStream<Uint8Array>) =>
        void (async () => {
          for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
            buf += new TextDecoder().decode(chunk);
            const m = buf.match(/opencode server listening on\s+(https?:\/\/\S+)/);
            if (m) {
              clearTimeout(timer);
              resolve(m[1]);
            }
          }
        })().catch(() => {});
      drain(proc.stdout);
      drain(proc.stderr);
    });
    const anon = await fetch(`${url}/app`);
    if (anon.status !== 401 && anon.status !== 403) {
      throw new Error(`unauthenticated request was NOT rejected (got ${anon.status})`);
    }
    const authed = await fetch(`${url}/app`, {
      headers: { Authorization: `Basic ${btoa(`opencode:${password}`)}` },
    });
    if (!authed.ok) throw new Error(`authenticated request failed (got ${authed.status})`);
    console.log(`auth: unauthenticated=${anon.status}, authenticated=${authed.status} — basic auth enforced\n`);
  } finally {
    try {
      proc.kill();
    } catch {}
  }
}

try {
  await verifyBasicAuth();
} catch (e: any) {
  console.error(`FAIL: basic-auth check: ${e?.message || e}`);
  process.exit(1);
}

if (!model) {
  console.error(
    "Basic-auth check passed, but no model to verify a run with: pass one " +
      "(bun scripts/verify-opencode.ts opencode/<provider>/<model>)\n" +
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
    // allowOpencode: trusted direct caller with deliberately no journal — the
    // runner's interactive gate is deny-by-default otherwise.
    { prompt, cwd, mode: "ask", mcpServers: [], allowOpencode: true },
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
