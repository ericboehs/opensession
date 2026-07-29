/**
 * Execution nodes — machines other than this one that sessions can run on.
 *
 * The motivating case is platform-locked work: an iOS build needs macOS with
 * Xcode, a Windows build needs MSVC, and neither can happen on the Linux box
 * that hosts OpenSession. Sandboxes do not solve this (they are ephemeral Linux
 * containers); a node is a persistent machine you own, attached on purpose.
 *
 * Trust model — this is the important part. A connected node executes agent
 * code, so attaching one is equivalent to handing over a shell. Two things gate
 * it:
 *
 *   1. **The node must be on the tailnet.** Registration and dial-back are
 *      rejected from anything outside Tailscale's 100.64.0.0/10 range. This is
 *      enforced here, not merely documented, because "put it on a private
 *      network" is the whole security boundary (docs/setup/networking.md).
 *   2. **Pairing is explicit and short-lived.** An operator runs
 *      `opensession nodes pair`, which mints a one-time code valid for ten
 *      minutes. The node redeems it once for a long-lived token. There is no
 *      open registration endpoint.
 *
 * Tokens are stored hashed; the plaintext is returned exactly once, at
 * redemption, and never logged.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { existsSync, readFileSync } from "fs";
import { randomUUIDv7 } from "bun";
import { statePath } from "./rename-compat";
import { writeJsonAtomic } from "./shared/atomic-write";

/** Resolved per call, not at import: tests point HOME at a scratch directory,
 *  and a module-level constant would have already baked in the real one. */
function storePath(): string {
  return statePath(".opensession-nodes.json", ".backstage-nodes.json");
}

/** Tailscale hands out addresses from the CGNAT range. */
const TAILNET_CIDR_PREFIX = 100;
const TAILNET_SECOND_OCTET = [64, 127] as const;

export type NodePlatform = "darwin" | "linux" | "win32";

export type ExecNode = {
  id: string;
  name: string;
  platform: NodePlatform;
  arch: string;
  /** Free-form markers a session can require: "xcode", "docker", "msbuild". */
  capabilities: string[];
  /** Address the node registered from; also what it must dial back from. */
  address: string;
  tokenHash: string;
  createdAt: string;
  createdBy?: string;
  lastSeenAt?: string;
  /** Operator note, e.g. "mac mini in the office". */
  label?: string;
};

type Store = { nodes: ExecNode[] };

function load(): Store {
  const path = storePath();
  if (!existsSync(path)) return { nodes: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.nodes) ? parsed : { nodes: [] };
  } catch {
    return { nodes: [] };
  }
}

function save(store: Store): void {
  writeJsonAtomic(storePath(), store);
}

// ── address gating ───────────────────────────────────────────────────────────

/**
 * Is this a Tailscale address?
 *
 * Loopback counts, so the server can attach itself as a node (useful for
 * testing and for a single-box install), but nothing else private does — a
 * 192.168.x LAN is not a trust boundary.
 */
export function isTailnetAddress(address: string): boolean {
  const ip = normalizeAddress(address);
  if (ip === "127.0.0.1" || ip === "::1") return true;
  const octets = ip.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === TAILNET_CIDR_PREFIX &&
    second >= TAILNET_SECOND_OCTET[0] &&
    second <= TAILNET_SECOND_OCTET[1]
  );
}

/** Strip IPv6-mapped IPv4 and any port suffix. */
export function normalizeAddress(address: string): string {
  let ip = (address || "").trim();
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  const lastColon = ip.lastIndexOf(":");
  // Only strip a port when this is not a bare IPv6 address.
  if (lastColon > 0 && ip.indexOf(":") === lastColon) ip = ip.slice(0, lastColon);
  return ip;
}

// ── pairing ──────────────────────────────────────────────────────────────────

const PAIRING_TTL_MS = 10 * 60_000;

type Pairing = { code: string; expiresAt: number; createdBy?: string };

// Deliberately in-memory: a pairing code should not survive a restart.
const g = globalThis as any;
const pairings: Map<string, Pairing> = (g.__opensessionNodePairings ??= new Map());

/** Human-typeable: no ambiguous characters, grouped for reading aloud. */
function pairingCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const raw = randomBytes(12);
  const chars = Array.from(raw, (b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}`;
}

export function createPairing(createdBy?: string): { code: string; expiresAt: number } {
  const code = pairingCode();
  const expiresAt = Date.now() + PAIRING_TTL_MS;
  pairings.set(code, { code, expiresAt, createdBy });
  return { code, expiresAt };
}

export function listPairings(): Pairing[] {
  const now = Date.now();
  for (const [code, p] of pairings) if (p.expiresAt <= now) pairings.delete(code);
  return [...pairings.values()];
}

/** One-time: a redeemed code is consumed whether or not registration succeeds. */
function redeemPairing(code: string): Pairing | undefined {
  const pairing = pairings.get(code.trim().toUpperCase());
  if (!pairing) return undefined;
  pairings.delete(pairing.code);
  return pairing.expiresAt > Date.now() ? pairing : undefined;
}

// ── registry ─────────────────────────────────────────────────────────────────

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function listNodes(): ExecNode[] {
  return load().nodes;
}

export function getNode(id: string): ExecNode | undefined {
  return load().nodes.find((n) => n.id === id);
}

export type RegisterInput = {
  code: string;
  name: string;
  platform: NodePlatform;
  arch: string;
  capabilities?: string[];
  label?: string;
  address: string;
};

export type RegisterResult =
  | { ok: true; node: ExecNode; token: string }
  | { ok: false; error: string };

export function registerNode(input: RegisterInput): RegisterResult {
  if (!isTailnetAddress(input.address)) {
    return {
      ok: false,
      error:
        "nodes must be on the tailnet — this address is outside 100.64.0.0/10. " +
        "See docs/setup/networking.md",
    };
  }

  const pairing = redeemPairing(input.code);
  if (!pairing) return { ok: false, error: "pairing code is invalid or expired" };

  const name = (input.name || "").trim();
  if (!name) return { ok: false, error: "name is required" };

  const token = randomBytes(32).toString("hex");
  const store = load();

  // Re-pairing a machine replaces its entry rather than accumulating
  // duplicates — the operator already proved intent by minting a fresh code.
  const existing = store.nodes.findIndex(
    (n) => n.name === name && n.platform === input.platform,
  );

  const node: ExecNode = {
    id: existing >= 0 ? store.nodes[existing].id : `node-${randomUUIDv7()}`,
    name,
    platform: input.platform,
    arch: input.arch,
    capabilities: (input.capabilities ?? []).filter(Boolean),
    address: normalizeAddress(input.address),
    tokenHash: hashToken(token),
    createdAt: existing >= 0 ? store.nodes[existing].createdAt : new Date().toISOString(),
    createdBy: pairing.createdBy,
    label: input.label,
  };

  if (existing >= 0) store.nodes[existing] = node;
  else store.nodes.push(node);
  save(store);

  return { ok: true, node, token };
}

/** Constant-time token check. Returns the node, or undefined. */
export function authenticateNode(id: string, token: string): ExecNode | undefined {
  const node = getNode(id);
  if (!node) return undefined;
  const expected = Buffer.from(node.tokenHash, "hex");
  const actual = Buffer.from(hashToken(token), "hex");
  if (expected.length !== actual.length) return undefined;
  return timingSafeEqual(expected, actual) ? node : undefined;
}

export function touchNode(id: string): void {
  const store = load();
  const node = store.nodes.find((n) => n.id === id);
  if (!node) return;
  node.lastSeenAt = new Date().toISOString();
  save(store);
}

export function removeNode(id: string): boolean {
  const store = load();
  const next = store.nodes.filter((n) => n.id !== id);
  if (next.length === store.nodes.length) return false;
  save({ nodes: next });
  return true;
}
