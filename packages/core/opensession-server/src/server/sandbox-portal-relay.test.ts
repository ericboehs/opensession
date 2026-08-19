import { expect, test } from "bun:test";
import { handleSandboxPortalRelayUpgrade, mintSandboxPortalGrant, revokeSandboxPortalGrants, revokeSandboxPortalRelay, verifySandboxPortalGrant } from "./sandbox-portal-relay";

test("Sandbox Portal grants bind one session, Sandbox, and port", () => {
	const grant = mintSandboxPortalGrant({ sessionId: "bks-test", sandboxId: "sandbox-test", port: 4300 });
	expect(verifySandboxPortalGrant(grant.token, { sessionId: "bks-test", sandboxId: "sandbox-test", port: 4300 })).toBe(true);
	expect(verifySandboxPortalGrant(grant.token, { sessionId: "bks-other", sandboxId: "sandbox-test", port: 4300 })).toBe(false);
	expect(verifySandboxPortalGrant(grant.token, { sessionId: "bks-test", sandboxId: "sandbox-test", port: 4301 })).toBe(false);
	revokeSandboxPortalGrants("sandbox-test");
	expect(verifySandboxPortalGrant(grant.token, { sessionId: "bks-test", sandboxId: "sandbox-test", port: 4300 })).toBe(false);
});

test("stopping one Portal revokes only its bound credential", () => {
	const api = mintSandboxPortalGrant({ sessionId: "bks-stop", sandboxId: "sandbox-stop", port: 4500 });
	const web = mintSandboxPortalGrant({ sessionId: "bks-stop", sandboxId: "sandbox-stop", port: 4501 });
	revokeSandboxPortalRelay("sandbox-stop", 4500);
	expect(verifySandboxPortalGrant(api.token, { sessionId: "bks-stop", sandboxId: "sandbox-stop", port: 4500 })).toBe(false);
	expect(verifySandboxPortalGrant(web.token, { sessionId: "bks-stop", sandboxId: "sandbox-stop", port: 4501 })).toBe(true);
});

test("relay upgrade rejects an unbound credential before WebSocket upgrade", () => {
	const grant = mintSandboxPortalGrant({ sessionId: "bks-relay", sandboxId: "sandbox-relay", port: 4400 });
	let upgraded: unknown;
	const server = { upgrade(_req: Request, options?: { data?: unknown }) { upgraded = options?.data; return true; } };
	const accepted = handleSandboxPortalRelayUpgrade(new Request("https://sessions.test/sandbox-portal-ws?session=bks-relay&sandbox=sandbox-relay&port=4400", { headers: { authorization: `Bearer ${grant.token}` } }), server, "/sandbox-portal-ws");
	expect(accepted).toBeUndefined();
	expect(upgraded).toMatchObject({ kind: "sandbox-portal-relay", sessionId: "bks-relay", sandboxId: "sandbox-relay", port: 4400 });
	const denied = handleSandboxPortalRelayUpgrade(new Request("https://sessions.test/sandbox-portal-ws?session=bks-relay&sandbox=sandbox-relay&port=4401", { headers: { authorization: `Bearer ${grant.token}` } }), server, "/sandbox-portal-ws");
	expect(denied?.status).toBe(403);
});
