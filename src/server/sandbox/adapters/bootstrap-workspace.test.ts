import { describe, expect, test } from "bun:test";
import {
  bootstrapRemoteWorkspaceRuntime,
  type RemoteDriver,
  type RemoteExecOpts,
} from "./bootstrap";

function fakeDriver(options?: { failBun?: boolean }) {
  const commands: string[] = [];
  let marked = false;
  const driver: RemoteDriver = {
    async exec(command: string, _opts?: RemoteExecOpts) {
      commands.push(command);
      if (command.startsWith("cat /home/ubuntu/.bks-workspace-runtime")) {
        return marked
          ? {
              exitCode: 0,
              stdout: "workspace-runtime-v1+bun\n",
              stderr: "",
            }
          : { exitCode: 1, stdout: "", stderr: "" };
      }
      if (
        options?.failBun &&
        command.includes("curl -fsSL https://bun.sh/install")
      ) {
        return { exitCode: 1, stdout: "", stderr: "bun unavailable" };
      }
      if (command.includes("> /home/ubuntu/.bks-workspace-runtime")) marked = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async execBackground() {},
    async writeFile() {},
    async ensureStarted() {},
  };
  return { driver, commands, marked: () => marked };
}

describe("bootstrapRemoteWorkspaceRuntime", () => {
  test("installs only the explicit workspace contract and fast-paths its marker", async () => {
    const fake = fakeDriver();
    await bootstrapRemoteWorkspaceRuntime(fake.driver, "test");
    expect(fake.marked()).toBe(true);
    const first = fake.commands.join("\n");
    expect(first).toContain("git curl unzip rg sed nl wc base64");
    expect(first).toContain("https://bun.sh/install");
    expect(first).not.toContain(".bks-runner");
    expect(first).not.toContain("claude.ai/install");
    expect(first).not.toContain("opencode-ai@");

    const count = fake.commands.length;
    await bootstrapRemoteWorkspaceRuntime(fake.driver, "test");
    expect(fake.commands.length).toBe(count + 1);
  });

  test("never writes the marker after a failed prerequisite", async () => {
    const fake = fakeDriver({ failBun: true });
    await expect(
      bootstrapRemoteWorkspaceRuntime(fake.driver, "test"),
    ).rejects.toThrow("bun install");
    expect(fake.marked()).toBe(false);
  });
});
