/**
 * Docker sandbox verification suite (Phases 1 + 2) — run MANUALLY:
 *
 *   bun run deploy/sandbox/verify.ts
 *
 * BIND section (Phase 1): exercises the DockerProvider end-to-end against a
 * scratch git repo + worktree (never a real session, never a real worktree):
 * container ensure/reuse, git status+commit THROUGH the bind-mounted worktree
 * + common .git, exec, RPC-socket reachability, the claude CLI, and — when
 * the account pool is available — a minimal real agent run through launchRun
 * (cheapest Claude model, "reply with OK", hard timeout). Degrades to a
 * dry-run notice when no account token exists.
 *
 * VOLUME section (Phase 2): a second sbxtest session materializes a
 * volume-only workspace (cloned in-container from a scratch LOCAL BARE repo —
 * no real GitHub repo involved), then drives the exec-routed surfaces
 * (workspaceExecFor → searchRepoFiles/getSessionDiff/getGitStatus), the
 * preview port publishing (in-container Bun.serve reached through the
 * published loopback port), the stopped-container host-exec fallback, and
 * the destroy-removes-the-workspace-volume contract.
 *
 * Everything is sbxtest-prefixed and cleaned up at the end. Safe to run next
 * to the live server: the run journal AND the sandbox config are redirected
 * to the scratch dir BEFORE any module import, so nothing here can leak into
 * ~/.backstage-chats/active-runs.json or flip the live sandbox config.
 */

const SCRATCH = `${process.env.HOME || "/home/ubuntu"}/.sandbox-verify-scratch`;
// MUST happen before importing any src/server module — claude-runner resolves
// the journal path at module load, and sandbox/config.ts resolves its config
// PATH at module load. The scratch config (written below) turns on the docker
// provider + volume workspace mode + a preview port WITHOUT touching the live
// ~/.backstage-sandbox.json.
process.env.BACKSTAGE_RUN_JOURNAL = `${SCRATCH}/active-runs.json`;
process.env.BACKSTAGE_SANDBOX_CONFIG = `${SCRATCH}/sandbox-config.json`;

import { existsSync, mkdirSync, rmSync } from "fs";

const { DockerProvider, containerNameFor } = await import("../../src/server/sandbox/docker");
const { workspaceExecFor } = await import("../../src/server/sandbox/workspace-exec");
const { searchRepoFiles } = await import("../../src/server/file-index");
const { getSessionDiff } = await import("../../src/server/git-diff");
const { getGitStatus } = await import("../../src/server/git-status");
const { REPOS, worktreePathFor } = await import("../../src/server/worktree");
const { rpcSocketPath } = await import("../../src/runner-host/protocol");
const { BACKSTAGE_CHATS_DIR } = await import("../../src/server/paths");
type RunHostSpec = import("../../src/runner-host/protocol").RunHostSpec;

const SESSION_ID = `sbxtest-${Date.now().toString(36)}`;
const CONTAINER = containerNameFor(SESSION_ID);
const MAIN = `${SCRATCH}/main-repo`;
const WT = `${SCRATCH}/wt-sbxtest`;
const BARE = `${SCRATCH}/origin.git`;

// Volume-mode section resources (own session/container; also sbxtest-*).
const VOL_SESSION_ID = `sbxtest-vol-${Date.now().toString(36)}`;
const VOL_CONTAINER = containerNameFor(VOL_SESSION_ID);
const VOL_BRANCH = "sbxtest-vol-branch";
const PREVIEW_PORT = 18734;

// Scratch sandbox config: docker provider, volume workspaces, one preview
// port. Read fresh per call by sandbox/config.ts via the env override above.
mkdirSync(SCRATCH, { recursive: true });
await Bun.write(
  process.env.BACKSTAGE_SANDBOX_CONFIG!,
  JSON.stringify({ provider: "docker", workspace: "volume", previewPorts: [PREVIEW_PORT] }),
);

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
  for (const [container, session] of [
    [CONTAINER, SESSION_ID],
    [VOL_CONTAINER, VOL_SESSION_ID],
  ]) {
    await sh(["docker", "rm", "-f", container]);
    await sh([
      "docker", "volume", "rm", "-f",
      `${container}-claude`, `${container}-codex`, `${container}-ws`,
    ]);
    try {
      rmSync(`${BACKSTAGE_CHATS_DIR}/sandboxes/${container}.json`, { force: true });
      rmSync(`${BACKSTAGE_CHATS_DIR}/sandbox-runs/${session}`, { recursive: true, force: true });
    } catch {}
  }
  delete REPOS["sbxtest"];
  // Transcript dirs the container-create mkdir'd for the scratch cwds.
  for (const dir of [WT, VOL_CWD]) {
    const munged = `-${dir.replaceAll("/", "-").replace(/^-/, "")}`;
    try {
      rmSync(`${process.env.HOME}/.claude/projects/${munged}`, { recursive: true, force: true });
    } catch {}
  }
  rmSync(SCRATCH, { recursive: true, force: true });
  console.log("  removed containers, volumes, state, scratch");
}

// ── scratch repo + worktree ───────────────────────────────────────────────────
console.log("── setup: scratch repo + worktree ──");
// Selective clean (NOT rmSync(SCRATCH) — the sandbox config written above
// lives there); cleanup() removes the whole scratch dir at the end.
for (const p of [MAIN, WT, BARE]) rmSync(p, { recursive: true, force: true });
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

// Local BARE origin for the volume-mode section: the in-container clone
// source (a local-path origin gets mounted ro by the provider — real repos
// clone over ssh/https instead). MAIN's `origin` remote points at it so
// repoOriginUrl resolves it.
await sh(["git", "clone", "-q", "--bare", MAIN, BARE]);
await sh(["git", "remote", "add", "origin", BARE], MAIN);
// Register the scratch repo in the (in-process) REPOS registry so the volume
// path can resolve clone source + default branch. sbxtest-only, in-memory.
REPOS["sbxtest"] = {
  id: "sbxtest",
  repo: MAIN,
  wtPrefix: "sbxtest",
  defaultBranch: "main",
  ghRepo: "sbxtest/sbxtest",
};
const VOL_CWD = worktreePathFor(VOL_BRANCH, "sbxtest", { isolated: true });

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

  // ── failed launch must not wedge the session busy ───────────────────────────
  // The HostHandle ctor registers a host-registry control keyed by the bks
  // session id; a connect failure (socket never appears) must drop it via
  // abandon() — the cleanup launchRunEager/spawnHostRun run in their catch —
  // or hostRunBusy() stays true forever and every future prompt reads busy.
  console.log("\n── failed-launch cleanup (host-registry) ──");
  const { HostHandle } = await import("../../src/server/host-client");
  const { hostRunBusy } = await import("../../src/server/host-registry");
  const failSession = `sbxtest-fail-${Date.now().toString(36)}`;
  const failDir = `${SCRATCH}/fail-run`;
  mkdirSync(failDir, { recursive: true });
  const failHandle = new HostHandle(
    failDir,
    { hostId: "rh-sbxtest-fail", bksSessionId: failSession, prompt: "x", cwd: WT,
      mode: "ask", model: "claude-haiku-4-5", mcpServers: [], journalKind: "sandbox-verify" },
    {},
    // Launcher that "succeeds" but never brings up a socket = unreachable host.
    { alive: () => false, newRunDir: () => failDir, launch: async () => {} },
  );
  ok("HostHandle ctor registers the run (session reads busy)", hostRunBusy(failSession));
  let connectThrew = false;
  try {
    await failHandle.connectWithWait(700);
  } catch {
    connectThrew = true;
  }
  ok("connectWithWait throws on an unreachable socket", connectThrew);
  failHandle.abandon();
  ok("abandon() clears the busy registration after a failed connect", !hostRunBusy(failSession));

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

  // ══ VOLUME MODE (Phase 2) ═════════════════════════════════════════════════
  // The workspace lives ONLY in a per-session volume: ensure() clones the
  // scratch bare origin inside the container; nothing appears host-side. The
  // read surfaces are exercised exec-routed (workspaceExecFor), exactly the
  // way backstage.ts routes them for such a session.
  console.log("\n══ volume-mode workspace ══");
  const vol = await provider.ensure({
    sessionId: VOL_SESSION_ID,
    repo: "sbxtest",
    branch: VOL_BRANCH,
    mode: "code",
  });
  ok("ensure() materialized a volume workspace", vol.workspace === "volume", `${vol.id} cwd=${vol.cwd}`);
  ok("cwd is the canonical worktree path", vol.cwd === VOL_CWD, vol.cwd);
  ok("no host dir was created", !existsSync(VOL_CWD));
  const wsVol = await sh(["docker", "volume", "inspect", `${VOL_CONTAINER}-ws`]);
  ok("workspace volume exists", wsVol.code === 0, `${VOL_CONTAINER}-ws`);
  const volStatus = await vol.exec(["git", "status", "--porcelain"]);
  ok("git works in the cloned volume", volStatus.exitCode === 0, volStatus.stderr.trim());
  const volBranch = await vol.exec(["git", "branch", "--show-current"]);
  ok("checked out the session branch", volBranch.stdout.trim() === VOL_BRANCH, volBranch.stdout.trim());
  const idem = await provider.ensure({
    sessionId: VOL_SESSION_ID,
    repo: "sbxtest",
    branch: VOL_BRANCH,
    mode: "code",
    cwd: VOL_CWD,
  });
  ok("ensure() is idempotent for volume workspaces", idem.id === vol.id && idem.workspace === "volume");

  // Exec-routed surfaces against the volume workspace, via the same session
  // shape backstage.ts derives the exec from.
  console.log("\n── exec-routed surfaces (volume) ──");
  const volSession = {
    sandbox: { provider: "docker", sandboxId: vol.id, workspace: "volume" },
    worktreeDir: VOL_CWD,
    repo: "sbxtest",
  };
  const exec = await workspaceExecFor(volSession);
  ok("workspaceExecFor routes into the sandbox", exec.sandboxed && exec.remote,
    `sandboxed=${exec.sandboxed} remote=${exec.remote}`);
  const hits = await searchRepoFiles(VOL_CWD, "readme", 20, exec);
  ok("searchRepoFiles (git ls-files in-container)", hits.includes("README.md"), hits.join(","));
  // Dirty the workspace: modify a tracked file + add an untracked one.
  await exec(["sh", "-c", "echo volume-edit >> README.md && echo new-untracked > sbx-vol-new.txt"]);
  const diff = await getSessionDiff(VOL_CWD, "main", exec);
  ok("getSessionDiff sees the tracked edit",
    diff.files.some((f) => f.path === "README.md" && f.status === "modified"),
    diff.files.map((f) => `${f.path}:${f.status}`).join(","));
  ok("getSessionDiff synthesizes the untracked file (remote fs reads)",
    diff.files.some((f) => f.path === "sbx-vol-new.txt" && f.status === "untracked") &&
      diff.rawPatch.includes("+new-untracked"),
    `rawPatch ${diff.rawPatch.length} chars`);
  const gs = await getGitStatus(VOL_CWD, "main", exec);
  ok("getGitStatus reads branch + dirty count in-container",
    gs.branch === VOL_BRANCH && gs.uncommittedFiles >= 2,
    `branch=${gs.branch} dirty=${gs.uncommittedFiles}`);

  // ── preview port publishing ─────────────────────────────────────────────────
  console.log("\n── preview ports ──");
  const portMap = await vol.ports();
  const hostPort = portMap[PREVIEW_PORT];
  ok("configured preview port is published to a loopback host port", !!hostPort,
    JSON.stringify(portMap));
  if (hostPort) {
    // Trivial static server INSIDE the container on the published port (the
    // tella-fusion dev-server flow needs toolchain the image doesn't carry
    // yet — gated behind devServerInSandbox; this proves the port+map layer).
    await sh(["docker", "exec", "-d", vol.id, "bun", "-e",
      `Bun.serve({ port: ${PREVIEW_PORT}, hostname: "0.0.0.0", fetch: () => new Response("sbx-preview-ok") });`]);
    let body = "";
    for (let i = 0; i < 20 && !body.includes("sbx-preview-ok"); i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        body = await (await fetch(`http://127.0.0.1:${hostPort}/`)).text();
      } catch {}
    }
    ok("host reaches the in-container server through the published port",
      body.includes("sbx-preview-ok"), JSON.stringify(body.slice(0, 40)));
  }

  // ── stopped container: reads fall back to host exec (never docker start) ──
  console.log("\n── stopped-container read fallback ──");
  await sh(["docker", "stop", "-t", "5", vol.id]);
  const execStopped = await workspaceExecFor(volSession);
  ok("stopped sandbox → host exec (no wake for reads)", !execStopped.sandboxed);
  ok("container was not started by the read path", (await vol.status()) === "stopped");

  // ── volume destroy contract ─────────────────────────────────────────────────
  console.log("\n── volume destroy ──");
  await provider.destroy(vol.id);
  const volGoneC = await sh(["docker", "inspect", vol.id]);
  const volGoneWs = await sh(["docker", "volume", "inspect", `${VOL_CONTAINER}-ws`]);
  ok("volume container removed", volGoneC.code !== 0);
  ok("workspace volume removed (documented data loss)", volGoneWs.code !== 0);
} finally {
  await cleanup();
}

console.log(`\n${pass} passed, ${fail} failed${fail ? ` — ${failures.join("; ")}` : ""}`);
process.exit(fail ? 1 : 0);
