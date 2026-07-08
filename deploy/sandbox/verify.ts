/**
 * Docker sandbox verification suite (Phase 1) — run MANUALLY:
 *
 *   bun run deploy/sandbox/verify.ts
 *
 * Exercises the DockerProvider end-to-end against a scratch git repo +
 * worktree (never a real session, never a real worktree): container
 * ensure/reuse, git status+commit THROUGH the bind-mounted worktree + common
 * .git, exec, RPC-socket reachability, the claude CLI, and — when the account
 * pool is available — a minimal real agent run through launchRun (cheapest
 * Claude model, "reply with OK", hard timeout). Degrades to a dry-run notice
 * when no account token exists. Cleans up its container/volumes/scratch at
 * the end (sbxtest-* resources only).
 *
 * Safe to run next to the live server: the run journal is redirected to the
 * scratch dir BEFORE any module import, so nothing this script journals can
 * leak into ~/.backstage-chats/active-runs.json (and thus into the live
 * boot-resume sweep).
 */

const SCRATCH = `${process.env.HOME || "/home/ubuntu"}/.sandbox-verify-scratch`;
// MUST happen before importing any src/server module — claude-runner resolves
// the journal path at module load.
process.env.BACKSTAGE_RUN_JOURNAL = `${SCRATCH}/active-runs.json`;

import { existsSync, mkdirSync, rmSync } from "fs";

const { DockerProvider, containerNameFor } = await import("../../src/server/sandbox/docker");
const { rpcSocketPath } = await import("../../src/runner-host/protocol");
const { BACKSTAGE_CHATS_DIR } = await import("../../src/server/paths");
type RunHostSpec = import("../../src/runner-host/protocol").RunHostSpec;

const SESSION_ID = `sbxtest-${Date.now().toString(36)}`;
const CONTAINER = containerNameFor(SESSION_ID);
const MAIN = `${SCRATCH}/main-repo`;
const WT = `${SCRATCH}/wt-sbxtest`;

let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    failures.push(name);
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function sh(cmd: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, out, err };
}

async function cleanup(): Promise<void> {
  console.log("\n── cleanup ──");
  await sh(["docker", "rm", "-f", CONTAINER]);
  await sh(["docker", "volume", "rm", "-f", `${CONTAINER}-claude`, `${CONTAINER}-codex`]);
  try {
    rmSync(`${BACKSTAGE_CHATS_DIR}/sandboxes/${CONTAINER}.json`, { force: true });
    rmSync(`${BACKSTAGE_CHATS_DIR}/sandbox-runs/${SESSION_ID}`, { recursive: true, force: true });
  } catch {}
  // Transcript dir the bind mount created for the scratch cwd.
  const munged = `-${WT.replaceAll("/", "-").replace(/^-/, "")}`;
  try {
    rmSync(`${process.env.HOME}/.claude/projects/${munged}`, { recursive: true, force: true });
  } catch {}
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log("  removed container, volumes, state, scratch");
}

// ── scratch repo + worktree ───────────────────────────────────────────────────
console.log("── setup: scratch repo + worktree ──");
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(MAIN, { recursive: true });
for (const c of [
  ["git", "init", "-q", "-b", "main"],
  ["git", "config", "user.email", "sbxtest@backstage.local"],
  ["git", "config", "user.name", "Sandbox Verify"],
]) await sh(c, MAIN);
await Bun.write(`${MAIN}/README.md`, "sandbox verify scratch repo\n");
await sh(["git", "add", "README.md"], MAIN);
await sh(["git", "commit", "-q", "-m", "init"], MAIN);
const wtAdd = await sh(["git", "worktree", "add", "-q", WT, "-b", "sbxtest-branch"], MAIN);
ok("scratch worktree created", wtAdd.code === 0 && existsSync(`${WT}/.git`), WT);

const provider = new DockerProvider();

try {
  // ── ensure / reuse ──────────────────────────────────────────────────────────
  console.log("\n── ensure ──");
  const t0 = Date.now();
  const sandbox = await provider.ensure({ sessionId: SESSION_ID, cwd: WT });
  ok("ensure() created + started container", sandbox.id === CONTAINER, `${sandbox.id} in ${Date.now() - t0}ms`);
  ok("status() is running", (await sandbox.status()) === "running");

  const t1 = Date.now();
  const again = await provider.ensure({ sessionId: SESSION_ID, cwd: WT });
  ok("ensure() is idempotent (reuse)", again.id === sandbox.id && Date.now() - t1 < 5000, `${Date.now() - t1}ms`);

  const inspect = await sh(["docker", "inspect", "-f",
    "{{index .Config.Labels \"backstage.session\"}} cpus={{.HostConfig.NanoCpus}} mem={{.HostConfig.Memory}} init={{.HostConfig.Init}}",
    CONTAINER]);
  ok("labels + limits + --init applied",
    inspect.out.includes(SESSION_ID) && inspect.out.includes("init=true"),
    inspect.out.trim());
  const homeMounts = await sh(["docker", "inspect", "-f", "{{range .Mounts}}{{.Destination}}\n{{end}}", CONTAINER]);
  ok("no volume shadows /home/ubuntu",
    !homeMounts.out.split("\n").includes("/home/ubuntu"),
    "mounts: " + homeMounts.out.trim().split("\n").join(", "));

  // ── exec + toolchain ────────────────────────────────────────────────────────
  console.log("\n── exec / toolchain ──");
  const whoami = await sandbox.exec(["id", "-u"]);
  ok("exec runs as uid 1000", whoami.exitCode === 0 && whoami.stdout.trim() === "1000", whoami.stdout.trim());
  const claudeVer = await sandbox.exec(["/home/ubuntu/.local/bin/claude", "--version"]);
  ok("claude CLI runs in-container", claudeVer.exitCode === 0, claudeVer.stdout.trim() || claudeVer.stderr.trim());
  const bunVer = await sandbox.exec(["bun", "--version"]);
  ok("bun runs in-container", bunVer.exitCode === 0, bunVer.stdout.trim());
  const settings = await sandbox.exec(["cat", "/home/ubuntu/.claude/settings.json"]);
  ok("~/.claude/settings.json seeded in volume", settings.exitCode === 0 && settings.stdout.trim().length > 0, settings.stdout.trim());

  // ── git through the mounts ──────────────────────────────────────────────────
  console.log("\n── git inside the sandbox ──");
  const status = await sandbox.exec(["git", "status", "--porcelain"]);
  ok("git status works (worktree + common .git mounts)", status.exitCode === 0, status.stderr.trim());
  await sandbox.exec(["sh", "-c", "echo sandbox-was-here > sandbox-file.txt"]);
  await sandbox.exec(["git", "add", "sandbox-file.txt"]);
  const commit = await sandbox.exec([
    "git", "-c", "user.email=sbxtest@backstage.local", "-c", "user.name=Sandbox Verify",
    "commit", "-q", "-m", "commit from inside the sandbox",
  ]);
  ok("git commit inside container", commit.exitCode === 0, commit.stderr.trim());
  const hostLog = await sh(["git", "log", "--oneline", "-1"], WT);
  ok("commit visible host-side", hostLog.out.includes("commit from inside the sandbox"), hostLog.out.trim());

  // ── IMDS block ──────────────────────────────────────────────────────────────
  console.log("\n── network ──");
  const imds = await sandbox.exec(["sh", "-c",
    "curl -s -m 3 -o /dev/null -w '%{http_code}' http://169.254.169.254/latest/meta-data/ || echo blocked"]);
  ok("IMDS unreachable from container", imds.stdout.includes("blocked") || imds.stdout.trim() === "000", imds.stdout.trim());

  // ── RPC socket ──────────────────────────────────────────────────────────────
  console.log("\n── rpc socket ──");
  const sock = rpcSocketPath(BACKSTAGE_CHATS_DIR);
  const sockLs = await sandbox.exec(["ls", sock]);
  ok("rpc socket mounted", sockLs.exitCode === 0, sock);
  const sockProbe = await sandbox.exec(["bun", "-e",
    `const r = await fetch("http://backstage/mcp/list", {method:"POST", unix:"${sock}", headers:{"content-type":"application/json"}, body:"{}"}); console.log("HTTP", r.status);`]);
  ok("rpc socket answers from inside", sockProbe.exitCode === 0 && sockProbe.stdout.includes("HTTP"),
    (sockProbe.stdout || sockProbe.stderr).trim().slice(0, 120));

  // ── real agent run through launchRun ───────────────────────────────────────
  console.log("\n── agent run (launchRun) ──");
  const accountsPath = process.env.BACKSTAGE_CLAUDE_ACCOUNTS_PATH ||
    `${process.env.HOME}/.backstage-claude-accounts.json`;
  let hasAccounts = false;
  try {
    const store = JSON.parse(await Bun.file(accountsPath).text());
    hasAccounts = Array.isArray(store.accounts) && store.accounts.length > 0;
  } catch {}
  if (!hasAccounts) {
    console.log("  (dry-run: no account pool at", accountsPath, "— skipping the live agent run)");
  } else {
    const spec: RunHostSpec = {
      hostId: `rh-verify-${Date.now().toString(36)}`,
      bksSessionId: SESSION_ID,
      prompt: "Reply with exactly: OK",
      cwd: WT,
      mode: "ask",
      model: "claude-haiku-4-5",
      mcpServers: [],
      journalKind: "sandbox-verify",
    };
    const handle = sandbox.launchRun(spec, {});
    const events: string[] = [];
    let doneText = "";
    let sawInit = false;
    const consume = (async () => {
      for await (const ev of handle.events()) {
        events.push(ev.type);
        if (ev.type === "init") sawInit = true;
        if (ev.type === "text_chunk") doneText += ev.text || "";
        if (ev.type === "done" || ev.type === "error") return ev;
      }
      return null;
    })();
    const result = await Promise.race([
      consume,
      new Promise<null>((r) => setTimeout(() => r(null), 180_000)),
    ]);
    if (!result) handle.cancel();
    ok("run emitted init (engine session started in-container)", sawInit, events.slice(0, 6).join(","));
    ok("run finished with done", result?.type === "done",
      result ? `${result.type}: ${(result.result || result.content || "").slice(0, 120)}` : "timed out after 180s");
    ok("model replied", /\bOK\b/i.test(doneText) || /\bOK\b/i.test(result?.result || ""), JSON.stringify(doneText.slice(0, 80)));
    const transcriptDir = `${process.env.HOME}/.claude/projects/-${WT.replaceAll("/", "-").replace(/^-/, "")}`;
    ok("engine transcript visible host-side", existsSync(transcriptDir), transcriptDir);
  }

  // ── stop/start lifecycle ────────────────────────────────────────────────────
  console.log("\n── lifecycle ──");
  await sh(["docker", "stop", "-t", "5", CONTAINER]);
  ok("stopped", (await sandbox.status()) === "stopped");
  const revived = await provider.ensure({ sessionId: SESSION_ID, cwd: WT });
  ok("ensure() restarts a stopped container", (await revived.status()) === "running");
  const got = await provider.get(CONTAINER);
  ok("get() reattaches by id", got !== null && got.cwd === WT, got?.cwd);

  // ── destroy ─────────────────────────────────────────────────────────────────
  console.log("\n── destroy ──");
  await provider.destroy(CONTAINER);
  const goneC = await sh(["docker", "inspect", CONTAINER]);
  const goneV = await sh(["docker", "volume", "inspect", `${CONTAINER}-claude`]);
  ok("container removed", goneC.code !== 0);
  ok("volumes removed", goneV.code !== 0);
  ok("worktree untouched by destroy", existsSync(`${WT}/sandbox-file.txt`));
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed${fail ? ` — ${failures.join("; ")}` : ""}`);
process.exit(fail ? 1 : 0);
