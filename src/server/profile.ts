import { homedir } from "os";

export interface LocalProfileIdentity {
	login: string;
	name: string;
}

const g = globalThis as typeof globalThis & {
	__localProfileIdentity?: LocalProfileIdentity;
};

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

export function localAuthRequestKind(
	path: string,
	method: string,
): "status" | "protected" | null {
	if (path === "/backstage/api/auth/status" && method === "GET") return "status";
	if (path === "/backstage/ws") return "protected";
	if (path.startsWith("/backstage/api/") && path !== "/backstage/api/health") {
		return "protected";
	}
	return null;
}

export function localProfileRoot(): string {
  return `${process.env.HOME || homedir()}/os1`;
}

export function setLocalProfileIdentity(identity: LocalProfileIdentity | null): void {
	if (identity) {
		g.__localProfileIdentity = {
			login: identity.login.trim(),
			name: identity.name.trim().split(" ")[0],
		};
	} else delete g.__localProfileIdentity;
}

export function localProfileLogin(): string {
	return g.__localProfileIdentity?.login || "";
}

/** Single-user identity for the loopback-only local server. */
export function localProfileUser(): string {
	return g.__localProfileIdentity?.name || "";
}
