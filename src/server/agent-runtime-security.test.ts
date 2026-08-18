import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  AGENT_APPARMOR_PROFILE,
  __setAgentAppArmorProfileLoadedForTest,
  secureAgentCommand,
} from "./agent-runtime-security";

describe("agent credential isolation", () => {
  test("wraps model-controlled commands without adding credential material", () => {
    const previous = process.env.CREDENTIALS_DIRECTORY;
    delete process.env.CREDENTIALS_DIRECTORY;
    __setAgentAppArmorProfileLoadedForTest(true);
    try {
      const command = secureAgentCommand(["/bin/bash", "-c", "true"]);
      const serialized = JSON.stringify(command);
      expect(serialized).not.toContain("mcp-oauth-key");
      expect(serialized).not.toContain("CREDENTIALS_DIRECTORY");
      expect(command.slice(0, 4)).toEqual([
        "/usr/bin/aa-exec",
        "-p",
        AGENT_APPARMOR_PROFILE,
        "--",
      ]);
    } finally {
      __setAgentAppArmorProfileLoadedForTest(undefined);
      if (previous === undefined) delete process.env.CREDENTIALS_DIRECTORY;
      else process.env.CREDENTIALS_DIRECTORY = previous;
    }
  });

  test("fails closed when protected OAuth state exists without confinement", () => {
    const root = mkdtempSync(`${tmpdir()}/agent-runtime-security-`);
    const previous = {
      state: process.env.OPENSESSION_STATE_DIR,
      credentials: process.env.CREDENTIALS_DIRECTORY,
    };
    process.env.OPENSESSION_STATE_DIR = root;
    process.env.CREDENTIALS_DIRECTORY = `${root}/credentials`;
    writeFileSync(`${root}/.opensession-mcp-oauth.json`, "{}\n");
    __setAgentAppArmorProfileLoadedForTest(false);
    try {
      expect(() => secureAgentCommand(["/bin/true"])).toThrow(
        "AppArmor profile is not loaded",
      );
    } finally {
      __setAgentAppArmorProfileLoadedForTest(undefined);
      if (previous.state === undefined) delete process.env.OPENSESSION_STATE_DIR;
      else process.env.OPENSESSION_STATE_DIR = previous.state;
      if (previous.credentials === undefined)
        delete process.env.CREDENTIALS_DIRECTORY;
      else process.env.CREDENTIALS_DIRECTORY = previous.credentials;
    }
  });

  test("the profile denies credential files and process-environment escape paths", () => {
    const profile = readFileSync(
      resolve(import.meta.dir, "../../deploy/apparmor/opensession-agent"),
      "utf8",
    );
    expect(profile).toContain("deny /run/credentials/** r");
    expect(profile).toContain("deny @{PROC}/[0-9]*/environ r");
    expect(profile).toContain("deny @{PROC}/[0-9]*/fd/** rwkl");
    expect(profile).toContain("deny ptrace (read, trace) peer=unconfined");
    expect(profile).toContain("root@{HOME}/.opensession-mcp-oauth.json* rwkl");
    expect(profile).toContain(".opensession-mcp-oauth.json* rwkl");
    expect(profile).toContain(".opensession.env rwkl");
    expect(profile).toContain("deny /var/lib/opensession/** rwklx");
  });
});
