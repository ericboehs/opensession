import { homedir } from "os";

/** The local profile is opt-in; unset and every other value keep cloud behavior. */
export function isLocalProfile(): boolean {
  return process.env.OPENSESSION_PROFILE === "local";
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/** Local mode has no login gate, so it only accepts same-origin loopback traffic. */
export function localRequestAllowed(req: Request): boolean {
  try {
    const target = new URL(req.url);
    if (!isLoopbackHostname(target.hostname)) return false;
    const origin = req.headers.get("origin");
    if (!origin) return true;
    const source = new URL(origin);
    return isLoopbackHostname(source.hostname) && source.origin === target.origin;
  } catch {
    return false;
  }
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
