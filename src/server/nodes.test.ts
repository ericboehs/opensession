/**
 * Execution-node registry tests.
 *
 * These are mostly security assertions rather than behaviour checks: attaching a
 * node is equivalent to handing someone a shell on that machine, so the gates
 * (tailnet-only, one-time pairing, hashed tokens, constant-time compare) are the
 * part that must not regress quietly.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  authenticateNode,
  createPairing,
  isTailnetAddress,
  listNodes,
  normalizeAddress,
  registerNode,
  removeNode,
} from "./nodes";

// Point HOME at a scratch dir so the real ~/.opensession-nodes.json is untouched.
const HOME = mkdtempSync(join(tmpdir(), "os-nodes-test-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterAll(() => {
  process.env.HOME = realHome;
  rmSync(HOME, { recursive: true, force: true });
});

beforeEach(() => {
  for (const node of listNodes()) removeNode(node.id);
});

const TAILNET = "100.101.102.103";

function register(overrides: Partial<Parameters<typeof registerNode>[0]> = {}) {
  const { code } = createPairing("tester");
  return registerNode({
    code,
    name: "mac-mini",
    platform: "darwin",
    arch: "arm64",
    capabilities: ["xcode"],
    address: TAILNET,
    ...overrides,
  });
}

describe("tailnet gating", () => {
  test("accepts Tailscale's CGNAT range and loopback only", () => {
    for (const ip of ["100.64.0.1", "100.101.102.103", "100.127.255.254", "127.0.0.1", "::1"]) {
      expect(isTailnetAddress(ip)).toBe(true);
    }
    // 100.63 and 100.128 sit just outside 100.64.0.0/10.
    for (const ip of ["100.63.255.255", "100.128.0.1", "10.0.0.1", "192.168.1.5", "8.8.8.8", ""]) {
      expect(isTailnetAddress(ip)).toBe(false);
    }
  });

  test("a private LAN address is not a trust boundary", () => {
    // Explicit: it would be tempting to allow RFC1918, and it must not be.
    expect(isTailnetAddress("192.168.0.10")).toBe(false);
    expect(isTailnetAddress("172.16.0.10")).toBe(false);
  });

  test("registration from off the tailnet is refused", () => {
    const result = register({ address: "8.8.8.8" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("tailnet");
    expect(listNodes()).toHaveLength(0);
  });

  test("normalizes IPv6-mapped IPv4 and strips a port", () => {
    expect(normalizeAddress("::ffff:100.64.0.1")).toBe("100.64.0.1");
    expect(normalizeAddress("100.64.0.1:54321")).toBe("100.64.0.1");
    expect(normalizeAddress(" 100.64.0.1 ")).toBe("100.64.0.1");
  });
});

describe("pairing", () => {
  test("a code works exactly once", () => {
    const { code } = createPairing();
    const first = registerNode({
      code, name: "a", platform: "linux", arch: "x64", address: TAILNET,
    });
    expect(first.ok).toBe(true);

    const second = registerNode({
      code, name: "b", platform: "linux", arch: "x64", address: TAILNET,
    });
    expect(second.ok).toBe(false);
  });

  test("an unknown code is refused", () => {
    const result = registerNode({
      code: "ZZZZ-ZZZZ", name: "a", platform: "linux", arch: "x64", address: TAILNET,
    });
    expect(result.ok).toBe(false);
  });

  test("codes avoid visually ambiguous characters", () => {
    for (let i = 0; i < 40; i++) {
      const { code } = createPairing();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      // 0/O and 1/I are the pairs people mistype when reading a code aloud.
      expect(code).not.toMatch(/[01OI]/);
    }
  });
});

describe("tokens", () => {
  test("the plaintext token is returned once and never stored", () => {
    const result = register();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    const stored = listNodes()[0];
    expect(stored.tokenHash).not.toBe(result.token);
    expect(JSON.stringify(stored)).not.toContain(result.token);
  });

  test("authenticates with the right token and rejects everything else", () => {
    const result = register();
    if (!result.ok) throw new Error("registration failed");

    expect(authenticateNode(result.node.id, result.token)?.id).toBe(result.node.id);
    expect(authenticateNode(result.node.id, "wrong")).toBeUndefined();
    expect(authenticateNode(result.node.id, "")).toBeUndefined();
    expect(authenticateNode("node-does-not-exist", result.token)).toBeUndefined();
  });
});

describe("registry", () => {
  test("re-pairing the same machine replaces it and rotates the token", () => {
    const first = register();
    if (!first.ok) throw new Error("first registration failed");

    const second = register();
    if (!second.ok) throw new Error("second registration failed");

    expect(listNodes()).toHaveLength(1);
    expect(second.node.id).toBe(first.node.id);      // same identity
    expect(second.node.createdAt).toBe(first.node.createdAt);
    expect(second.token).not.toBe(first.token);       // fresh credential
    // The old token must stop working.
    expect(authenticateNode(first.node.id, first.token)).toBeUndefined();
  });

  test("records platform, arch and capabilities", () => {
    const result = register({ capabilities: ["xcode", "docker"] });
    if (!result.ok) throw new Error("registration failed");
    expect(result.node.platform).toBe("darwin");
    expect(result.node.arch).toBe("arm64");
    expect(result.node.capabilities).toEqual(["xcode", "docker"]);
  });

  test("a name is required", () => {
    expect(register({ name: "   " }).ok).toBe(false);
  });
});
