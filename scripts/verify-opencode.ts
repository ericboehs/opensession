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
 * To verify a bridge mode without enabling it globally:
 *   BACKSTAGE_OPENCODE_CONFIG=/tmp/oc.json bun scripts/verify-opencode.ts
 *   with /tmp/oc.json = {"enabled":true}                       // meridian (default)
 *                  or = {"enabled":true,"bridge":{"mode":"native"},
 *                        "bridgeAccountIds":["<account id>"]}  // native bridge
 *   (account ids: jq '.accounts[]|{id,name}' ~/.backstage-claude-accounts.json)
 *
 * Meridian runs get extra assertions: run-level audit events were emitted, no
 * stray opencode/meridian processes survive cleanup (killServer's SIGKILL
 * escalation — the meridian plugin swallows SIGTERM), and the host
 * ~/.claude/.credentials.json + ~/.config/opencode are untouched (account
 * isolation goes through per-account CLAUDE_CONFIG_DIR, never the host login).
 */

import { existsSync, mkdtempSync, statSync, readFileSync, readdirSync } from "fs";
import { tmpdir, homedir } from "os";
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
const bridgeDesc = bridgeCfg?.enabled
  ? `enabled, mode=${bridgeCfg.bridgeMode} (accounts: ${bridgeCfg.bridgeAccountIds?.length ?? "picker default"})`
  : "disabled";
console.log(`model: ${model}\ncwd:   ${cwd}\nbridge: ${bridgeDesc}\n`);

// ── Meridian-mode pre-state (host isolation + audit assertions) ─────────────
const meridianMode =
  model.startsWith("opencode/anthropic/") && bridgeCfg?.enabled && bridgeCfg.bridgeMode === "meridian";
const HOME_DIR = homedir();
const fileSnap = (p: string): string => {
  try {
    const s = statSync(p);
    return `mtime=${s.mtimeMs} size=${s.size}`;
  } catch {
    return "absent";
  }
};
const treeSnap = (dir: string): string => {
  // Newest mtime + entry count across the tree — any write in there changes it.
  let newest = 0;
  let count = 0;
  const walk = (d: string) => {
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      count++;
      if (s.mtimeMs > newest) newest = s.mtimeMs;
      if (s.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return `newest=${newest} entries=${count}`;
};
const hostClaudeBefore = fileSnap(`${HOME_DIR}/.claude/.credentials.json`);
const hostOpencodeCfgBefore = treeSnap(`${HOME_DIR}/.config/opencode`);
const startedAt = new Date();

let sawDone = false;
let sawError: string | undefined;
try {
  for await (const ev of runOpencode(
    // allowOpencode: trusted direct caller with deliberately no journal — the
    // runner's interactive gate is deny-by-default otherwise. No `user` is
    // passed, so a meridian run picks a shared POOL account (personal
    // accounts are only eligible for their owner's runs).
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

const failures: string[] = [];
if (!sawDone || sawError) failures.push(sawError || "run ended without a done event");

if (meridianMode) {
  console.log("\n── meridian assertions ──");

  // 1. Run-level audit events (start + end) landed in today's audit log.
  const auditFile = `${HOME_DIR}/.backstage-audit/audit-${startedAt.toISOString().slice(0, 10)}.jsonl`;
  let events: any[] = [];
  try {
    events = readFileSync(auditFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(
        (e) => e && e.msg === "opencode_meridian_run" && new Date(e.time) >= startedAt
      );
  } catch {}
  const startEv = events.find((e) => e.phase === "start");
  const endEv = events.find((e) => e.phase === "end");
  if (startEv && endEv) {
    console.log(
      `audit: start+end events emitted (account=${startEv.account}, meridian=${startEv.meridian_version}, ` +
        `plugin=${startEv.plugin_version}, end status=${endEv.status}, ${endEv.duration_ms}ms)`
    );
    if (endEv.status !== "success") failures.push(`meridian end audit status "${endEv.status}" (want success)`);
  } else {
    failures.push(`meridian audit events missing (start=${!!startEv}, end=${!!endEv}) in ${auditFile}`);
  }

  // 2. No stray processes: wait out killServer's SIGKILL escalation (the
  //    meridian plugin swallows SIGTERM), then look for opencode/claude
  //    processes younger than this script. Long-lived ones belong to real
  //    backstage sessions and are not ours.
  await new Promise((r) => setTimeout(r, 7_000));
  const elapsedS = Math.ceil((Date.now() - startedAt.getTime()) / 1000) + 5;
  const ps = Bun.spawnSync(["ps", "-eo", "pid,etimes,args"]).stdout.toString();
  const strays = ps
    .split("\n")
    .filter((l) => {
      // Match actual stack processes (the executable itself), not unrelated
      // command lines that merely mention a meridian-ish path.
      const m = l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) return false;
      const [, , etimes, args] = m;
      const exe = (args.split(/\s+/)[0] || "").split("/").pop() || "";
      const isStack =
        /(^|\/)opencode serve\b/.test(args) ||
        ["opencode", "meridian", "claude-max-proxy"].includes(exe) ||
        (exe === "claude" && !args.includes(".claude/remote"));
      return isStack && Number(etimes) <= elapsedS;
    });
  if (strays.length) failures.push(`stray processes survived cleanup:\n${strays.join("\n")}`);
  else console.log("processes: no stray opencode/meridian processes after cleanup");

  // 3. Host auth state untouched: account isolation must go through the
  //    per-account CLAUDE_CONFIG_DIR, never the host login or opencode's own
  //    global config.
  const hostClaudeAfter = fileSnap(`${HOME_DIR}/.claude/.credentials.json`);
  const hostOpencodeCfgAfter = treeSnap(`${HOME_DIR}/.config/opencode`);
  if (hostClaudeAfter !== hostClaudeBefore)
    failures.push(`host ~/.claude/.credentials.json changed (${hostClaudeBefore} → ${hostClaudeAfter})`);
  else console.log("host: ~/.claude/.credentials.json untouched");
  if (hostOpencodeCfgAfter !== hostOpencodeCfgBefore)
    failures.push(`host ~/.config/opencode changed (${hostOpencodeCfgBefore} → ${hostOpencodeCfgAfter})`);
  else console.log("host: ~/.config/opencode untouched");
}

if (!failures.length) {
  console.log("\nPASS: opencode run completed" + (meridianMode ? " (meridian mode, all assertions held)" : ""));
  process.exit(0);
}
console.error(`\nFAIL:\n- ${failures.join("\n- ")}`);
process.exit(1);
