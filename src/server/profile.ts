import { homedir } from "os";

/** The local profile is opt-in; unset and every other value keep cloud behavior. */
export function isLocalProfile(): boolean {
  return process.env.OPENSESSION_PROFILE === "local";
}

export function localProfileRoot(): string {
  return `${process.env.HOME || homedir()}/os1`;
}

/** Single-user identity for the loopback-only local server. */
export function localProfileUser(): string {
  const configured = process.env.OPENSESSION_LOCAL_USER?.trim();
  if (configured) return configured;
  try {
    const result = Bun.spawnSync(["git", "config", "user.name"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const name = result.stdout.toString().trim();
    if (result.exitCode === 0 && name) return name;
  } catch {}
  return "local";
}
