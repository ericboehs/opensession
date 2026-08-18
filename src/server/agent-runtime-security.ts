/** Host boundary for model-controlled runtimes.
 *
 * Open Session and its engines normally share a Unix uid. The AppArmor profile
 * removes the coordinator's systemd credential mount and sensitive host state
 * from engine/shell access while preserving the existing workspace access.
 */
import { existsSync } from "node:fs";
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
