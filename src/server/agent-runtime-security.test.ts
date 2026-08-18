import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  AGENT_APPARMOR_PROFILE,
  __setAgentAppArmorProfileLoadedForTest,
  secureAgentCommand,
  procAttrConfinedByAgentProfile,
  processConfinedByAgentProfile,
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
    // A transient unit created through the systemd USER manager does not
    // inherit this profile, so an open path to that manager makes every deny
    // above decorative. The socket rules are what close it; denying the
    // systemd-run/systemctl/busctl binaries alone would not, since a raw
    // D-Bus client reaches the same manager.
    expect(profile).toContain("deny /run/user/[0-9]*/systemd/private rwkl");
    expect(profile).toContain("deny /run/user/[0-9]*/bus rwkl");
    expect(profile).toContain("deny /run/systemd/private rwkl");
    expect(profile).toContain("deny dbus bus=session");
    expect(profile).toContain(
      "deny dbus bus=system peer=(name=org.freedesktop.systemd1)",
    );
  });
});

describe("adopting a process that predates confinement", () => {
  // Reusing a survivor is the one path that can hand a model-controlled
  // process the credential mount after the key is installed, because the
  // process was spawned before the profile existed. The parse is what decides
  // it, so complain mode and a foreign profile both have to read as unconfined.
  test("only an enforcing instance of our own profile counts", () => {
    expect(procAttrConfinedByAgentProfile("opensession-agent (enforce)")).toBe(true);
    // The kernel NUL-terminates this file.
    expect(procAttrConfinedByAgentProfile("opensession-agent (enforce)\n\0")).toBe(true);
    expect(procAttrConfinedByAgentProfile("opensession-agent (complain)")).toBe(false);
    expect(procAttrConfinedByAgentProfile("unconfined")).toBe(false);
    expect(procAttrConfinedByAgentProfile("")).toBe(false);
    expect(procAttrConfinedByAgentProfile("something-else (enforce)")).toBe(false);
    // Prefix games: a neighbouring profile whose name starts with ours.
    expect(procAttrConfinedByAgentProfile("opensession-agent-lax (enforce)")).toBe(false);
  });

  test("a pid with no readable attr file is treated as unconfined", () => {
    // Nothing is running as pid 0, so the read fails and must fail closed.
    expect(processConfinedByAgentProfile(0)).toBe(false);
  });
});
