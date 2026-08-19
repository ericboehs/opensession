#!/usr/bin/env bun
/**
 * Manual verification for the OpenCode engine (docs/self-hosting-sandboxes.md,
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
 *      enabled (~/.opensession-opencode.json, or a test config via
 *      OPENSESSION_OPENCODE_CONFIG) — this exercises the full bridge path.
 *   3. Otherwise exits with instructions (an API-key provider needs
 *      `opencode auth login` first).
 *
 * To verify a bridge mode without enabling it globally:
 *   OPENSESSION_OPENCODE_CONFIG=/tmp/oc.json bun scripts/verify-opencode.ts
 *   with /tmp/oc.json = {"enabled":true}                       // meridian (default)
 *                  or = {"enabled":true,"bridge":{"mode":"native"},
 *                        "bridgeAccountIds":["<account id>"]}  // native bridge
 *   (account ids: jq '.accounts[]|{id,name}' ~/.opensession-claude-accounts.json)
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
} from "../packages/core/opensession-server/src/server/opencode-runner";
import { readOpencodeBridgeConfig } from "../packages/core/opensession-server/src/server/opencode-config";
import { listCodexAccounts } from "../packages/core/opensession-server/src/server/codex-accounts";

const argModel = process.argv[2];
const prompt = process.argv[3] || "Reply with exactly: OK";

const bridgeCfg = readOpencodeBridgeConfig();
// A codex "home" account = a ChatGPT-subscription login (CODEX_HOME/auth.json),
// which is what opencode/openai/* seeds from (opencode-openai-auth.ts).
const hasCodexHome = listCodexAccounts().some((a) => a.kind === "home");
// Model resolution: explicit arg wins; else the anthropic bridge default when
// enabled; else the openai subscription path when a codex home account exists
// (the cheapest ChatGPT-plan model verified live — gpt-5.4-mini).
const model =
  argModel ||
  (bridgeCfg?.enabled
    ? "opencode/anthropic/claude-haiku-4-5"
    : hasCodexHome
      ? "opencode/openai/gpt-5.4-mini"
      : "");

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
      "or enable the Anthropic bridge, or add a codex ChatGPT (home) account for the " +
      "opencode/openai path (see header comment). API-key providers need `opencode auth login`."
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

// ── OpenAI-mode pre-state (rotation-hazard assertion) ───────────────────────
// The core correctness guarantee (opencode-openai-auth.ts): opencode is seeded
// access-token-only + a placeholder refresh, so it can NEVER rotate/invalidate
// the codex refresh token. Snapshot every codex home account's live tokens now
// and re-check them after the run — they must be byte-identical.
const openaiMode = model.startsWith("opencode/openai/");
const codexAuthBefore = new Map<string, string>();
if (openaiMode) {
  for (const a of listCodexAccounts()) {
    if (a.kind !== "home") continue;
    try {
      const t = JSON.parse(readFileSync(`${a.value}/auth.json`, "utf-8"))?.tokens ?? {};
      codexAuthBefore.set(a.id, `${t.access_token ?? ""}|${t.refresh_token ?? ""}`);
    } catch {}
  }
}
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
  const auditFile = `${HOME_DIR}/.opensession-audit/audit-${startedAt.toISOString().slice(0, 10)}.jsonl`;
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
  //    opensession sessions and are not ours.
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

if (openaiMode) {
  console.log("\n── openai (ChatGPT subscription) assertions ──");

  // 1. Run-level audit events (opencode_openai_run start + end).
  const auditFile = `${HOME_DIR}/.opensession-audit/audit-${startedAt.toISOString().slice(0, 10)}.jsonl`;
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
      .filter((e) => e && e.msg === "opencode_openai_run" && new Date(e.time) >= startedAt);
  } catch {}
  const startEv = events.find((e) => e.phase === "start");
  const endEv = events.find((e) => e.phase === "end");
  if (startEv && endEv) {
    console.log(
      `audit: start+end emitted (account=${startEv.account}, mechanism=${startEv.mechanism}, ` +
        `end status=${endEv.status}, ${endEv.duration_ms}ms)`
    );
    if (endEv.status !== "success") failures.push(`openai end audit status "${endEv.status}" (want success)`);
  } else {
    failures.push(`openai audit events missing (start=${!!startEv}, end=${!!endEv}) in ${auditFile}`);
  }

  // 2. Rotation hazard held: no codex home account's tokens were rotated.
  let rotated = false;
  for (const a of listCodexAccounts()) {
    if (a.kind !== "home" || !codexAuthBefore.has(a.id)) continue;
    let after = "";
    try {
      const t = JSON.parse(readFileSync(`${a.value}/auth.json`, "utf-8"))?.tokens ?? {};
      after = `${t.access_token ?? ""}|${t.refresh_token ?? ""}`;
    } catch {}
    if (after !== codexAuthBefore.get(a.id)) {
      rotated = true;
      failures.push(`codex account "${a.name}" auth.json tokens changed during the run (rotation hazard!)`);
    }
  }
  if (!rotated) console.log("codex auth: all home-account tokens untouched (opencode never rotated the refresh family)");
}

if (!failures.length) {
  console.log(
    "\nPASS: opencode run completed" +
      (meridianMode ? " (meridian mode, all assertions held)" : "") +
      (openaiMode ? " (openai ChatGPT-subscription mode, all assertions held)" : "")
  );
  process.exit(0);
}
console.error(`\nFAIL:\n- ${failures.join("\n- ")}`);
process.exit(1);
