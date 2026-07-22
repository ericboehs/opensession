import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { getSandboxProvider } from "../index";
import {
  cleanupRemoteRunWithRetry,
  makeRemoteLauncher,
  remoteRuntimePaths,
  shellQuoteWord,
  type RemoteDriver,
} from "./bootstrap";
import type { ExecResult } from "../provider";
import {
  acquireMacosLease,
  acquireMacosMutationLock,
  buildLaunchAgentPlist,
  buildSshArgs,
  createMacosSshDriver,
  launchAgentCleanupCommand,
  macosCleanupCommand,
  pipeMacosRemoteFile,
  readCappedStreamText,
  releaseMacosMutationLock,
  resolveMacosWorkspacePath,
  statMacosRemotePath,
  verifyMacosReadiness,
  type MacosRemoteProcess,
  type SshRunner,
} from "./macos";

describe("capped SSH output", () => {
  test("fails explicitly instead of returning truncated stdout", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345"));
        controller.close();
      },
    });

    await expect(readCappedStreamText(stream, 4, true)).rejects.toThrow(
      "remote command stdout exceeds the 4-byte capture cap",
    );
  });
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("macOS runtime paths", () => {
  test("keeps existing Linux defaults byte-identical", () => {
    expect(remoteRuntimePaths()).toEqual({
      home: "/home/ubuntu",
      bun: "/home/ubuntu/.bun/bin/bun",
      claude: "/home/ubuntu/.local/bin/claude",
      opencode: "/home/ubuntu/.bun/bin/opencode",
      runnerRepo: "/home/ubuntu/projects/tella-backstage",
      hostEntry: "/home/ubuntu/projects/tella-backstage/src/runner-host/host.ts",
      openaiSeedDir: "/home/ubuntu/.opensession-openai-seeds",
      path: "/home/ubuntu/.bun/bin:/home/ubuntu/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      warmBase: "/home/ubuntu/.bks-warm",
      runsBase: "/home/ubuntu/.opensession-chats/sandbox-runs",
    });
  });

  test("derives every runner path from a macOS home", () => {
    const paths = remoteRuntimePaths(
      "/Users/runner",
      "/Users/runner/src/backstage",
      "/Users/runner/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin",
    );
    expect(paths.hostEntry).toBe("/Users/runner/src/backstage/src/runner-host/host.ts");
    expect(paths.runsBase).toBe("/Users/runner/.opensession-chats/sandbox-runs");
    expect(paths.path).toContain("/opt/homebrew/bin");
  });
});

describe("remote run recovery", () => {
  test("binds liveness to the runner entrypoint and exact run spec", async () => {
    const calls: string[] = [];
    const runtime = remoteRuntimePaths("/Users/runner", "/Users/runner/backstage");
    const driver: RemoteDriver = {
      async exec(command) {
        calls.push(command);
        if (command.includes("meta.json")) {
          return { exitCode: 0, stdout: JSON.stringify({ pid: 4242 }), stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };

    const launcher = makeRemoteLauncher(driver, "bks-recovery", runtime);
    expect(await launcher.alive("/tmp/rh-one", null)).toBe(false);
    expect(calls[1]).toContain(runtime.hostEntry);
    expect(calls[1]).toContain(
      "/Users/runner/.opensession-chats/sandbox-runs/bks-recovery/rh-one/spec.json",
    );
  });

  test("retries macOS cleanup while another process holds the mutation lock", async () => {
    let attempts = 0;
    await cleanupRemoteRunWithRetry(
      {
        runKey: "rh-cleanup",
        cwd: "/tmp/worktree",
        sandboxProvider: "macos",
        startedAt: new Date().toISOString(),
      },
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("node is being mutated by another process");
      },
      0,
    );
    expect(attempts).toBe(3);
  });
});

describe("macOS SSH transport", () => {
  test("constructs a noninteractive argv-safe SSH invocation", () => {
    const argv = buildSshArgs(
      {
        host: "mac-mini.tailnet.ts.net",
        user: "opensession",
        port: 2222,
        identityFile: "/home/ubuntu/.ssh/mac node",
        remoteHome: "/Users/opensession",
      },
      "printf '%s' \"hello world\"",
    );
    expect(argv.slice(0, 8)).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ConnectTimeout=10",
    ]);
    expect(argv).toContain("opensession@mac-mini.tailnet.ts.net");
    expect(argv).toContain("/home/ubuntu/.ssh/mac node");
    expect(argv.at(-1)).toBe(`/bin/sh -lc 'printf '\\''%s'\\'' "hello world"'`);
  });

  test("writes and bootstraps a unique Aqua LaunchAgent", async () => {
    const calls: Array<{ argv: string[]; input?: string }> = [];
    const runner: SshRunner = async (argv, options) => {
      calls.push({ argv, input: options?.input });
      const command = argv.at(-1) || "";
      if (command.includes("id -u")) return { exitCode: 0, stdout: "501\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const driver = createMacosSshDriver(
      {
        host: "mac-mini.tailnet.ts.net",
        user: "opensession",
        remoteHome: "/Users/opensession",
      },
      "bks-test/session",
      runner,
    );

    await driver.execBackground("bun run screenshot.ts", {
      env: { HOME: "/Users/opensession", DISPLAY_NAME: "A&B" },
    });

    const write = calls.find((call) => call.input?.includes("<key>Label</key>"));
    expect(write).toBeDefined();
    expect(write!.input).toContain("com.tella.opensession.bks-test-session.");
    expect(write!.input).toContain("<string>Aqua</string>");
    expect(write!.input).toContain("<string>A&amp;B</string>");
    expect(write!.input).toContain("launchctl bootout gui/501/");
    const bootstrap = calls.find((call) => call.argv.at(-1)?.includes("launchctl bootstrap gui/501"));
    expect(bootstrap).toBeDefined();
    expect(bootstrap!.argv.at(-1)).toContain("Library/LaunchAgents/com.tella.opensession.bks-test-session.");
  });

  test("fails clearly when the Aqua launchd domain is unavailable", async () => {
    const driver = createMacosSshDriver(
      { host: "mac", remoteHome: "/Users/runner" },
      "bks-test",
      async () => ({ exitCode: 1, stdout: "", stderr: "no domain" }),
    );
    expect(driver.ensureStarted()).rejects.toThrow("no active gui/$UID launchd domain");
  });
});

describe("LaunchAgent and readiness helpers", () => {
  test("plist escapes command, paths, and environment", () => {
    const plist = buildLaunchAgentPlist({
      label: "com.tella.opensession.test",
      command: "printf '<done>'",
      stdoutPath: "/tmp/a&b.log",
      stderrPath: "/tmp/error.log",
      environment: { TOKEN: 'a&b"c' },
    });
    expect(plist).toContain("printf &apos;&lt;done&gt;&apos;");
    expect(plist).toContain("/tmp/a&amp;b.log");
    expect(plist).toContain("a&amp;b&quot;c");
  });

  test("cleanup is scoped to one session label", () => {
    const command = launchAgentCleanupCommand("bks-123/unsafe", true);
    expect(command).toContain("com.tella.opensession.bks-123-unsafe.*.plist");
    expect(command).toContain("launchctl bootout");
  });

  test("readiness verifies Darwin arm64, Xcode, Aqua, tools, and runner SHA", async () => {
    const commands: string[] = [];
    const runtime = remoteRuntimePaths("/Users/runner");
    const driver: RemoteDriver = {
      async exec(command) {
        commands.push(command);
        if (command === "uname -s && uname -m") {
          return { exitCode: 0, stdout: "Darwin\narm64\n", stderr: "" };
        }
        if (command.includes("opencode") && command.includes("--version")) {
          return { exitCode: 0, stdout: "1.17.15\n", stderr: "" };
        }
        if (command.includes("rev-parse HEAD")) {
          return { exitCode: 0, stdout: "abc123\n", stderr: "" };
        }
        return { exitCode: 0, stdout: "ok\n", stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };
    await verifyMacosReadiness(driver, runtime, "abc123");
    expect(commands.some((command) => command.includes("xcodebuild -version"))).toBe(true);
    expect(commands.some((command) => command.includes("/dev/console"))).toBe(true);
    expect(commands.some((command) => command.includes(runtime.hostEntry))).toBe(true);
  });

  test("provider registry exposes macos", () => {
    expect(getSandboxProvider("macos").id).toBe("macos");
  });
});

/** Fake driver that returns scripted responses in call order, so lease tests
 *  can walk acquireMacosLease's exact decision tree (tryAcquire →
 *  macosLeaseActive → cleanup → tryAcquire again) without a real Mac. */
function sequenceDriver(results: ExecResult[]): { driver: RemoteDriver; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const driver: RemoteDriver = {
    async exec(cmd) {
      calls.push(cmd);
      const r = results[i++];
      if (!r) throw new Error(`test driver ran out of scripted responses at call ${i}: ${cmd.slice(0, 160)}`);
      return r;
    },
    async execBackground() {},
    async writeFile() {},
    async ensureStarted() {},
  };
  return { driver, calls };
}

function localShellDriver(): RemoteDriver {
  return {
    async exec(command) {
      const proc = Bun.spawn(["/bin/sh", "-lc", command], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
    async execBackground() {},
    async writeFile() {},
    async ensureStarted() {},
  };
}

describe("acquireMacosLease (node-wide foreground lease)", () => {
  test("acquires an uncontended lease while holding the distributed mutation lock", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const { driver, calls } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" }, // mutation lock
      { exitCode: 0, stdout: "", stderr: "" }, // tryAcquire
      { exitCode: 0, stdout: "", stderr: "" }, // release mutation lock
    ]);
    await acquireMacosLease(driver, runtime, "bks-1", "run-1");
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("foreground-mutation.lock");
    expect(calls[0]).toContain("fcntl.LOCK_EX | fcntl.LOCK_NB");
    expect(calls[1]).toContain("/Users/runner/.opensession-node/foreground-lease");
    expect(calls[1]).toContain('"sessionId":"bks-1"');
    expect(calls[1]).toContain('"runId":"run-1"');
    expect(calls[1]).toContain('mv "$owner_tmp"');
    expect(calls[1]).toContain("exit 72");
  });

  test("the Python mutation holder acquires and releases a real OS lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "macos-mutation-lock-"));
    temporaryDirectories.push(home);
    const runtime = remoteRuntimePaths(home);
    const driver = localShellDriver();

    await acquireMacosLease(driver, runtime, "bks-1", "run-1");
    expect(existsSync(join(home, ".opensession-node", "foreground-mutation-owner.json"))).toBe(
      false,
    );
    expect(existsSync(join(home, ".opensession-node", "foreground-lease", "owner.json"))).toBe(
      true,
    );
  });

  test("renews the OS lock beyond its original TTL", async () => {
    const home = mkdtempSync(join(tmpdir(), "macos-mutation-heartbeat-"));
    temporaryDirectories.push(home);
    const runtime = remoteRuntimePaths(home);
    const driver = localShellDriver();
    const lock = await acquireMacosMutationLock(driver, runtime, {
      ttlSeconds: 1,
      heartbeatMs: 100,
    });
    try {
      await Bun.sleep(1_300);
      await expect(
        acquireMacosMutationLock(driver, runtime, { ttlSeconds: 1, heartbeatMs: 100 }),
      ).rejects.toThrow("being mutated by another process");
    } finally {
      await releaseMacosMutationLock(driver, runtime, lock);
    }

    const next = await acquireMacosMutationLock(driver, runtime, {
      ttlSeconds: 1,
      heartbeatMs: 100,
    });
    await releaseMacosMutationLock(driver, runtime, next);
  });

  test("rejects a contended lease still inside the stale window without an active-process check", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const now = new Date("2026-07-21T12:00:00Z");
    const owner = {
      sessionId: "bks-other",
      runId: "run-other",
      acquiredAt: new Date(now.getTime() - 1_000).toISOString(),
    };
    const { driver, calls } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 73, stdout: JSON.stringify(owner), stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    await expect(acquireMacosLease(driver, runtime, "bks-1", "run-1", now)).rejects.toThrow(
      /busy with bks-other/,
    );
    // Fresh lease: short-circuits on age, never probes whether the owner is
    // actually alive and never touches its files.
    expect(calls).toHaveLength(3);
  });

  test("rejects a stale-timed lease whose owner process is still alive", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const now = new Date("2026-07-21T12:10:00Z");
    const owner = {
      sessionId: "bks-other",
      runId: "run-other",
      acquiredAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    };
    const { driver, calls } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" }, // mutation lock
      { exitCode: 73, stdout: JSON.stringify(owner), stderr: "" }, // tryAcquire
      { exitCode: 0, stdout: "", stderr: "" }, // macosLeaseActive: alive
      { exitCode: 0, stdout: "", stderr: "" }, // release mutation lock
    ]);
    await expect(acquireMacosLease(driver, runtime, "bks-1", "run-1", now)).rejects.toThrow(
      /busy with bks-other/,
    );
    expect(calls).toHaveLength(4);
    expect(calls[2]).toContain("plutil -extract pid");
    expect(calls[2]).toContain("ps -p");
    expect(calls[2]).toContain("spec.json");
  });

  test("reclaims a stale dead lease, cleaning up the previous owner before retrying", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const now = new Date("2026-07-21T12:10:00Z");
    const owner = {
      sessionId: "bks-other",
      runId: "run-other",
      acquiredAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    };
    const { driver, calls } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" }, // mutation lock
      { exitCode: 73, stdout: JSON.stringify(owner), stderr: "" }, // tryAcquire #1: contended
      { exitCode: 1, stdout: "", stderr: "" }, // macosLeaseActive: dead
      { exitCode: 73, stdout: JSON.stringify(owner), stderr: "" }, // re-read under lock
      { exitCode: 1, stdout: "", stderr: "" }, // owner still dead under lock
      { exitCode: 0, stdout: "", stderr: "" }, // cleanupMacosRun for the stale owner
      { exitCode: 0, stdout: "", stderr: "" }, // tryAcquire #2: succeeds
      { exitCode: 0, stdout: "", stderr: "" }, // release mutation lock
    ]);
    await acquireMacosLease(driver, runtime, "bks-1", "run-1", now);
    expect(calls).toHaveLength(8);
    // Cleanup is scoped to the STALE owner's session/run, not the new claimant.
    expect(calls[5]).toContain("for plist in");
    expect(calls[5]).toContain("bks-other");
    expect(calls[5]).not.toContain("bks-1");
    // The retried acquire claims the lease for the NEW run.
    expect(calls[6]).toContain('"sessionId":"bks-1"');
  });

  test("surfaces a concurrent-claim race as a clear retry error", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const now = new Date("2026-07-21T12:10:00Z");
    const owner = {
      sessionId: "bks-other",
      runId: "run-other",
      acquiredAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    };
    const { driver } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" }, // mutation lock
      { exitCode: 73, stdout: JSON.stringify(owner), stderr: "" }, // tryAcquire #1: contended
      { exitCode: 1, stdout: "", stderr: "" }, // macosLeaseActive: dead
      { exitCode: 73, stdout: JSON.stringify(owner), stderr: "" }, // re-read under lock
      { exitCode: 1, stdout: "", stderr: "" }, // owner still dead
      { exitCode: 0, stdout: "", stderr: "" }, // cleanup
      { exitCode: 73, stdout: JSON.stringify(owner), stderr: "" }, // tryAcquire #2: someone else won
      { exitCode: 0, stdout: "", stderr: "" }, // release mutation lock
    ]);
    await expect(acquireMacosLease(driver, runtime, "bks-1", "run-1", now)).rejects.toThrow(
      /claimed concurrently/,
    );
  });

  test("treats a just-created lease without owner.json as initializing", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const { driver, calls } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 74, stdout: "__INITIALIZING__\n", stderr: "" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    await expect(acquireMacosLease(driver, runtime, "bks-1", "run-1")).rejects.toThrow(
      /still initializing/,
    );
    expect(calls).toHaveLength(3);
  });

  test("does not report success when owner publication fails", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const { driver, calls } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 72, stdout: "", stderr: "owner write failed" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    await expect(acquireMacosLease(driver, runtime, "bks-1", "run-1")).rejects.toThrow(
      /foreground lease failed.*owner write failed/s,
    );
    expect(calls).toHaveLength(3);
  });

  test("never deletes an owner replaced before stale reclamation", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const now = new Date("2026-07-21T12:10:00Z");
    const stale = {
      sessionId: "bks-stale",
      runId: "run-stale",
      acquiredAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    };
    const replacement = { ...stale, sessionId: "bks-new", runId: "run-new" };
    const { driver, calls } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" }, // mutation lock
      { exitCode: 73, stdout: JSON.stringify(stale), stderr: "" },
      { exitCode: 1, stdout: "", stderr: "" },
      { exitCode: 73, stdout: JSON.stringify(replacement), stderr: "" }, // changed owner
      { exitCode: 0, stdout: "", stderr: "" }, // release mutation lock
    ]);
    await expect(acquireMacosLease(driver, runtime, "bks-1", "run-1", now)).rejects.toThrow(
      /changed while reclaiming/,
    );
    expect(calls.some((call) => call.includes(".backstage-claude-accounts.json"))).toBe(false);
  });

  test("backs off when another process holds the mutation lock", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const now = new Date("2026-07-21T12:10:00Z");
    const { driver, calls } = sequenceDriver([
      { exitCode: 1, stdout: "", stderr: "" }, // another process holds mutation lock
    ]);
    await expect(acquireMacosLease(driver, runtime, "bks-1", "run-1", now)).rejects.toThrow(
      /being mutated/,
    );
    // The OS-backed nonblocking flock is never deleted or stolen by a waiter.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.includes(".backstage-claude-accounts.json"))).toBe(true);
    expect(calls[0]).toContain("fcntl.LOCK_EX | fcntl.LOCK_NB");
    expect(calls[0]).toContain(" 300");
  });

  test("treats a transport failure during liveness probing as unknown", async () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const now = new Date("2026-07-21T12:10:00Z");
    const owner = {
      sessionId: "bks-other",
      runId: "run-other",
      acquiredAt: new Date(now.getTime() - 10 * 60_000).toISOString(),
    };
    const { driver, calls } = sequenceDriver([
      { exitCode: 0, stdout: "", stderr: "" },
      { exitCode: 73, stdout: JSON.stringify(owner), stderr: "" },
      { exitCode: 255, stdout: "", stderr: "connection lost" },
      { exitCode: 0, stdout: "", stderr: "" },
    ]);
    await expect(acquireMacosLease(driver, runtime, "bks-1", "run-1", now)).rejects.toThrow(
      /liveness probe failed \(255\).*connection lost/s,
    );
    expect(calls).toHaveLength(4);
  });
});

describe("macosCleanupCommand (run/session teardown)", () => {
  test("removing a specific run also removes its workspace and credential material", () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const runDir = `${runtime.runsBase}/bks-1`;
    const workspace = "/Users/runner/.opensession-workspaces/bks-1/tella-fusion";
    const command = macosCleanupCommand(runtime, "bks-1", "run-1", workspace);
    expect(command).toContain(`rm -rf ${shellQuoteWord(runDir)}`);
    expect(command).toContain(`rm -rf ${shellQuoteWord(workspace)}`);
    expect(command).toContain(".backstage-claude-accounts.json");
    expect(command).toContain(".backstage-codex-accounts.json");
    expect(command).toContain(".opensession-openai-seeds");
    expect(command).toContain("foreground-lease");
    expect(command).toContain('[ "$owner_run" = run-1 ]');
    expect(command).toContain("for plist in");
    expect(command.indexOf('if ! { [ "$owner_run" = run-1 ]')).toBeLessThan(
      command.indexOf("for plist in"),
    );
    expect(command).toContain("launchctl print");
    expect(command).toContain('case "$command" in *"$run_dir/spec.json"*');
    expect(command).toContain("exit 76");
    expect(spawnSync("/bin/sh", ["-n"], { input: command }).status).toBe(0);
    // Workspace and global resources are released only after the owned run's
    // launchd job and recorded PID are both confirmed gone.
    expect(command.indexOf(`rm -rf ${shellQuoteWord(workspace)}`)).toBeGreaterThan(
      command.indexOf('if ! { [ "$owner_run" = run-1 ]'),
    );
    expect(command.indexOf(`rm -rf ${shellQuoteWord(workspace)}`)).toBeGreaterThan(
      command.indexOf("exit 76"),
    );
  });

  test("session destroy cleans its artifacts without disturbing another lease owner", () => {
    const runtime = remoteRuntimePaths("/Users/runner");
    const command = macosCleanupCommand(runtime, "bks-1");
    // Session-wide match: no comparison against owner_run, unlike the
    // per-run case above (`[ "$owner_run" = run-1 ] && ...`).
    expect(command).toContain('if [ -z "$owner_session" ] || [ "$owner_session" = bks-1 ]; then');
    expect(command).not.toContain('"$owner_run" =');
    // Session-owned agents are removed before consulting the global lease.
    expect(command.indexOf("for plist in")).toBeLessThan(command.indexOf("owner_session=$("));
    // No workspace argument: the caller supplies the checkout separately.
    expect(command).not.toContain("rm -rf /Users/runner/.opensession-workspaces");
  });
});

describe("resolveMacosWorkspacePath (import_remote_asset path confinement)", () => {
  test("confines a relative path to the session's remote workspace root", () => {
    expect(resolveMacosWorkspacePath("/Users/runner/ws", "artifacts/demo.mp4")).toBe(
      "/Users/runner/ws/artifacts/demo.mp4",
    );
    expect(resolveMacosWorkspacePath("/Users/runner/ws", "./demo.png")).toBe(
      "/Users/runner/ws/demo.png",
    );
  });

  test("rejects absolute paths and traversal out of the workspace", () => {
    expect(() => resolveMacosWorkspacePath("/Users/runner/ws", "/etc/passwd")).toThrow();
    expect(() => resolveMacosWorkspacePath("/Users/runner/ws", "../secrets")).toThrow();
    expect(() => resolveMacosWorkspacePath("/Users/runner/ws", "artifacts/../../secrets")).toThrow();
    expect(() => resolveMacosWorkspacePath("/Users/runner/ws", "")).toThrow();
  });
});

describe("statMacosRemotePath (import_remote_asset stat + checksum)", () => {
  test("parses a regular file's size and sha256", async () => {
    const sha = "a".repeat(64);
    const driver: RemoteDriver = {
      async exec() {
        return { exitCode: 0, stdout: `12345\n${sha}\n`, stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };
    expect(await statMacosRemotePath(driver, "/Users/runner/ws", "/Users/runner/ws/demo.mp4")).toEqual({
      kind: "file",
      size: 12345,
      sha256: sha,
    });
  });

  test("reports directories and missing paths distinctly from files", async () => {
    const respond = (stdout: string): RemoteDriver => ({
      async exec() {
        return { exitCode: 0, stdout, stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    });
    expect((await statMacosRemotePath(respond("DIR\n"), "/workspace", "/workspace/x")).kind).toBe("dir");
    expect((await statMacosRemotePath(respond("MISSING\n"), "/workspace", "/workspace/x")).kind).toBe("missing");
  });

  test("requires a valid checksum and a descriptor-confined remote command", async () => {
    let command = "";
    const driver: RemoteDriver = {
      async exec(cmd) {
        command = cmd;
        return { exitCode: 0, stdout: "12\nnot-a-sha\n", stderr: "" };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };
    await expect(
      statMacosRemotePath(driver, "/Users/runner/ws", "/Users/runner/ws/artifacts/demo.mp4"),
    ).rejects.toThrow(/invalid sha256/);
    expect(command).toContain("os.O_NOFOLLOW");
    expect(command).toContain("dir_fd=current");
    expect(command).toContain("os.fstat(target)");
    expect(command).toContain("hashlib.sha256()");
    expect(command).toContain("artifacts/demo.mp4 stat");
  });

  test("opens every path component without following symlinks", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "macos-asset-workspace-"));
    const outside = mkdtempSync(join(tmpdir(), "macos-asset-outside-"));
    temporaryDirectories.push(workspace, outside);
    mkdirSync(join(workspace, "artifacts"));
    writeFileSync(join(workspace, "artifacts", "demo.bin"), "descriptor confined");
    writeFileSync(join(outside, "secret.bin"), "secret");
    symlinkSync(outside, join(workspace, "linked"), "dir");
    const driver: RemoteDriver = {
      async exec(command) {
        const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
        return {
          exitCode: result.status ?? 1,
          stdout: result.stdout || "",
          stderr: result.stderr || result.error?.message || "",
        };
      },
      async execBackground() {},
      async writeFile() {},
      async ensureStarted() {},
    };

    const info = await statMacosRemotePath(
      driver,
      workspace,
      join(workspace, "artifacts", "demo.bin"),
    );
    expect(info.kind).toBe("file");
    expect(info.size).toBe(19);
    expect(info.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      statMacosRemotePath(driver, workspace, join(workspace, "linked", "secret.bin")),
    ).rejects.toThrow(/cannot open confined remote asset/);
  });
});

/** Build a fake SSH subprocess that yields the given chunks on stdout, so
 *  pipeMacosRemoteFile can be exercised without a real SSH connection. */
function fakeRemoteProcess(
  chunks: Uint8Array[],
  exitCode = 0,
  stderrText = "",
): MacosRemoteProcess {
  return {
    stdout: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderrText));
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    kill() {},
  };
}

describe("pipeMacosRemoteFile (binary transfer over SSH)", () => {
  const config = { host: "mac-mini.tailnet.ts.net", remoteHome: "/Users/runner" };

  test("preserves arbitrary binary bytes across the SSH round trip", async () => {
    // Non-UTF8-safe bytes (0x00, 0xFF, lone continuation bytes) that a text
    // decode would corrupt — proves the transport never touches a JS string.
    const payload = new Uint8Array([0, 1, 2, 255, 254, 253, 128, 10, 13, 0]);
    let argv: string[] = [];
    const buf = await pipeMacosRemoteFile(
      config,
      "/Users/runner/ws",
      "/Users/runner/ws/artifact.bin",
      1024,
      async (chunks) => {
        const received: Buffer[] = [];
        for await (const chunk of chunks) received.push(Buffer.from(chunk));
        return Buffer.concat(received);
      },
      (spawnArgv) => {
        argv = spawnArgv;
        return fakeRemoteProcess([payload.slice(0, 5), payload.slice(5)]);
      },
    );
    expect(new Uint8Array(buf)).toEqual(payload);
    expect(argv.at(-1)).toContain("os.O_NOFOLLOW");
    expect(argv.at(-1)).toContain("artifact.bin read");
  });

  test("enforces the size cap mid-stream", async () => {
    const big = new Uint8Array(2048).fill(7);
    await expect(
      pipeMacosRemoteFile(
        config,
        "/Users/runner/ws",
        "/Users/runner/ws/big.bin",
        1024,
        async (chunks) => {
          for await (const _chunk of chunks) {
            // Drain the stream; the transfer cap must stop it first.
          }
        },
        () => fakeRemoteProcess([big]),
      ),
    ).rejects.toThrow(/exceeds the 1024-byte import cap/);
  });

  test("surfaces a nonzero ssh exit as a clear error", async () => {
    await expect(
      pipeMacosRemoteFile(
        config,
        "/Users/runner/ws",
        "/Users/runner/ws/missing.bin",
        1024,
        async (chunks) => {
          for await (const _chunk of chunks) {
            // Drain so the SSH exit status becomes the reported error.
          }
        },
        () => fakeRemoteProcess([], 1, "cat: No such file or directory"),
      ),
    ).rejects.toThrow(/ssh exit 1.*No such file or directory/s);
  });

  test("kills and reaps ssh when the consumer fails", async () => {
    let killed = false;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const process = fakeRemoteProcess([new Uint8Array([1, 2, 3])]);
    process.exited = exited;
    process.kill = () => {
      killed = true;
      resolveExit(143);
    };

    await expect(
      pipeMacosRemoteFile(
        config,
        "/Users/runner/ws",
        "/Users/runner/ws/artifact.bin",
        1024,
        async () => {
          throw new Error("destination failed");
        },
        () => process,
      ),
    ).rejects.toThrow("destination failed");
    expect(killed).toBe(true);
  });
});
