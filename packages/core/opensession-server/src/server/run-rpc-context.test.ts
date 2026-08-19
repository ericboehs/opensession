import { afterEach, describe, expect, it } from "bun:test";
import {
  dispatchRunRpc,
  registerInteractiveMcpBuilder,
  registerOcSessionContext,
  registerRunToken,
  releaseOcSessionContext,
  unregisterRunToken,
  type OcSessionContext,
} from "./run-rpc";

// dispatchRunRpc needs a builder; a session that carries no such server
// answers tools/list with an empty list (200), which is the cheapest way to
// observe "this call resolved to a session" without building MCP servers.
const g = globalThis as any;
const previousBuilder = g.__runRpcMcpBuilder;
registerInteractiveMcpBuilder(() => ({}));

afterEach(() => {
  g.__runRpcMcpBuilder = previousBuilder;
  registerInteractiveMcpBuilder(() => ({}));
});

const list = (token: string, ocSession: string) =>
  dispatchRunRpc("/mcp/list", { token, server: "opensession-sessions", ocSession });

describe("run-rpc opencode session mapping", () => {
  it("releases only the registration it was given", async () => {
    const token = crypto.randomUUID();
    const ocSession = `ses_${crypto.randomUUID()}`;
    registerRunToken(token, { sessionId: "os-owner" });
    // Boot restores the mapping from the journal so the still-live detached
    // engine can call in; the reattach then registers its own for the same
    // engine session, as does the session's next prompt.
    const fromBoot: OcSessionContext = { sessionId: "os-owner", token };
    const fromReattach: OcSessionContext = { sessionId: "os-owner", token };
    try {
      registerOcSessionContext(ocSession, fromBoot);
      registerOcSessionContext(ocSession, fromReattach);

      // Releasing the boot registration must not take the live one with it.
      releaseOcSessionContext(ocSession, fromBoot);
      expect(await list(token, ocSession)).toMatchObject({ status: 200 });

      releaseOcSessionContext(ocSession, fromReattach);
      expect(await list(token, ocSession)).toMatchObject({
        status: 403,
        body: { error: "unauthorized (unresolved opencode session)" },
      });
    } finally {
      releaseOcSessionContext(ocSession, fromReattach);
      unregisterRunToken(token);
    }
  });

  it("ignores an unknown engine session id", () => {
    const ctx: OcSessionContext = { sessionId: "os-owner", token: "t" };
    expect(() => releaseOcSessionContext(undefined, ctx)).not.toThrow();
    expect(() => releaseOcSessionContext(`ses_${crypto.randomUUID()}`, ctx)).not.toThrow();
  });
});
