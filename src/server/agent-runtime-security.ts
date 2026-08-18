/** Host boundary for model-controlled runtimes.
 *
 * Open Session and its engines normally share a Unix uid. The AppArmor profile
 * removes the coordinator's systemd credential mount and sensitive host state
 * from engine/shell access while preserving the existing workspace access.
 */
import { existsSync, readFileSync } from "node:fs";
import { statePath } from "./paths";

export const AGENT_APPARMOR_PROFILE = "opensession-agent";
const AA_EXEC = "/usr/bin/aa-exec";
const APPARMOR_POLICY = "/etc/apparmor.d/opensession-agent";
let testProfileLoaded: boolean | undefined;
let profileProbe: { loaded: boolean; at: number } | undefined;

export function __setAgentAppArmorProfileLoadedForTest(
  loaded: boolean | undefined,
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("AppArmor test override is only available under bun test");
  }
  testProfileLoaded = loaded;
}

export function agentAppArmorProfileLoaded(): boolean {
  if (testProfileLoaded !== undefined) return testProfileLoaded;
  if (
    process.platform !== "linux" ||
    !existsSync(AA_EXEC) ||
    !existsSync(APPARMOR_POLICY)
  )
    return false;
  if (profileProbe && Date.now() - profileProbe.at < 5_000) {
    return profileProbe.loaded;
  }
  // apparmorfs' registry needs CAP_MAC_ADMIN even though its mode is 0444.
  // Probe the transition, then prove the profile is ENFORCING by attempting a
  // read its policy denies. Complain mode passes the first probe only.
  const transition = Bun.spawnSync({
    cmd: [AA_EXEC, "-p", AGENT_APPARMOR_PROFILE, "--", "/bin/true"],
    stdout: "ignore",
    stderr: "ignore",
  });
  const deniedRead =
    transition.exitCode === 0
      ? Bun.spawnSync({
          cmd: [
            AA_EXEC,
            "-p",
            AGENT_APPARMOR_PROFILE,
            "--",
            "/bin/cat",
            APPARMOR_POLICY,
          ],
          stdout: "ignore",
          stderr: "ignore",
        })
      : undefined;
  const loaded = transition.exitCode === 0 && deniedRead?.exitCode !== 0;
  profileProbe = { loaded, at: Date.now() };
  return loaded;
}

/** Read a profile name out of `/proc/<pid>/attr/current` and decide whether it
 *  is OUR profile, enforcing. Complain mode confines nothing, so it does not
 *  count; neither does `unconfined` nor another profile's name. Split out from
 *  the /proc read so the parse is testable without a live process. */
export function procAttrConfinedByAgentProfile(raw: string): boolean {
  // The kernel writes "opensession-agent (enforce)", with a trailing NUL.
  return raw.replace(/\0/g, "").trim() === `${AGENT_APPARMOR_PROFILE} (enforce)`;
}

/** Is this pid already running under our profile? Used to refuse REUSING a
 *  process that predates the profile: an engine spawned before confinement
 *  existed keeps the coordinator's view of /proc and the credential mount, so
 *  adopting it after the key is mounted would hand it exactly what the profile
 *  is there to deny. */
export function processConfinedByAgentProfile(pid: number): boolean {
  try {
    return procAttrConfinedByAgentProfile(
      readFileSync(`/proc/${pid}/attr/current`, "utf8"),
    );
  } catch {
    return false;
  }
}

/** Wrap a model-controlled process. A service carrying protected credentials
 * fails closed if its confinement profile was not installed. */
export function secureAgentCommand(command: string[]): string[] {
  if (agentAppArmorProfileLoaded()) {
    return [AA_EXEC, "-p", AGENT_APPARMOR_PROFILE, "--", ...command];
  }
  if (
    process.env.OPENSESSION_PERSONAL_MCP !== "0" &&
    process.env.CREDENTIALS_DIRECTORY &&
    existsSync(statePath(".opensession-mcp-oauth.json"))
  ) {
    throw new Error(
      "The opensession-agent AppArmor profile is not loaded. " +
        "Agent runtimes are disabled while protected credentials are mounted.",
    );
  }
  return command;
}
