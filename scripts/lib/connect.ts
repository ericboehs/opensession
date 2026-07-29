/**
 * `opensession connect` — attach this machine to a server as an execution node.
 *
 * The motivating case is platform-locked work: an iOS build needs macOS with
 * Xcode, a Windows build needs MSVC, and neither can happen on the Linux box
 * running the server. Sandboxes do not help — they are ephemeral Linux
 * containers. A node is a persistent machine you own.
 *
 * Deliberately NOT the same thing as a tunnel product. Tools like T3 Connect
 * solve *ingress* (reach my box from my phone, through NAT, without a VPN).
 * This solves *execution* (run this build somewhere that can build it), and it
 * requires the tailnet rather than working around the lack of one — which means
 * no relay to operate and no bandwidth to pay for.
 *
 * The credential lives in ~/.opensession/node.json (0600). Pairing codes are
 * one-time and expire in ten minutes, and the server records the address it saw
 * rather than one we claim.
 */

import { chmodSync, existsSync, mkdirSync } from "fs";
import { arch, hostname, platform } from "os";
import { join } from "path";
import { OPENSESSION_HOME } from "./paths";
import { bold, dim, fail, heading, info, ok, run, warn } from "./ui";

const IDENTITY_PATH = join(OPENSESSION_HOME, "node.json");
const HEARTBEAT_MS = 60_000;

type Identity = { server: string; id: string; token: string; name: string };

async function readIdentity(): Promise<Identity | undefined> {
  if (!existsSync(IDENTITY_PATH)) return undefined;
  try {
    return JSON.parse(await Bun.file(IDENTITY_PATH).text());
  } catch {
    return undefined;
  }
}

/** What this machine can do that the server's own box may not. */
async function detectCapabilities(): Promise<string[]> {
  const found: string[] = [];
  const has = async (bin: string) => Boolean(Bun.which(bin));

  if (platform() === "darwin") {
    // xcodebuild exists as a stub without the full Xcode; -version fails then.
    if (await has("xcodebuild")) {
      const { code } = await run(["xcodebuild", "-version"]);
      if (code === 0) found.push("xcode");
    }
    if (await has("swift")) found.push("swift");
  }
  if (platform() === "win32" && (await has("msbuild"))) found.push("msbuild");

  for (const [bin, cap] of [
    ["docker", "docker"],
    ["cargo", "rust"],
    ["go", "go"],
    ["bun", "bun"],
  ] as const) {
    if (await has(bin)) found.push(cap);
  }
  return found;
}

function normalizeServer(url: string): string {
  let value = url.trim().replace(/\/+$/, "");
  if (!value) return "";
  if (!/^https?:\/\//.test(value)) value = `http://${value}`;
  return value;
}

export type ConnectOptions = { server?: string; code?: string; name?: string; label?: string };

export async function connect(opts: ConnectOptions): Promise<number> {
  heading("Connect this machine");

  const server = normalizeServer(opts.server ?? "");
  if (!server) {
    fail("--server is required", "e.g. --server http://100.64.12.34:3850");
    return 1;
  }
  if (!opts.code) {
    fail("--code is required", "get one from the server with `opensession nodes pair`");
    return 1;
  }

  const name = opts.name?.trim() || hostname().replace(/\.local$/, "");
  const capabilities = await detectCapabilities();

  info(dim(`server        ${server}`));
  info(dim(`this machine  ${name} (${platform()}/${arch()})`));
  info(dim(`capabilities  ${capabilities.join(", ") || "none detected"}`));

  let response: Response;
  try {
    response = await fetch(`${server}/backstage/api/nodes/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: opts.code,
        name,
        platform: platform(),
        arch: arch(),
        capabilities,
        label: opts.label,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    fail(`could not reach ${server}`, (err as Error).message);
    info(dim("  the server must be reachable from this machine — usually the tailnet"));
    return 1;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}) as any);
    fail(`registration refused (${response.status})`, body?.error ?? "");
    if (response.status === 403) {
      info(dim("  either the pairing code is wrong/expired, or this machine is not"));
      info(dim("  on the tailnet — see docs/setup/networking.md"));
    }
    return 1;
  }

  const { node, token } = (await response.json()) as { node: { id: string }; token: string };

  mkdirSync(OPENSESSION_HOME, { recursive: true });
  await Bun.write(IDENTITY_PATH, JSON.stringify({ server, id: node.id, token, name }, null, 2) + "\n");
  chmodSync(IDENTITY_PATH, 0o600);

  ok(`registered as ${name}`, node.id);
  info(dim(`  credential written to ${IDENTITY_PATH} (0600)`));

  heading("Next");
  info(`${bold("opensession node run")}    stay connected (heartbeat every 60s)`);
  info(dim("  run it under a service manager to keep this node attached across reboots"));
  return 0;
}

/** Long-running: keeps the node visible to the server. */
export async function nodeRun(): Promise<number> {
  const identity = await readIdentity();
  if (!identity) {
    fail("this machine is not connected", "run `opensession connect` first");
    return 1;
  }

  info(dim(`heartbeating to ${identity.server} as ${identity.name} (${identity.id})`));
  let failures = 0;

  const beat = async () => {
    try {
      const response = await fetch(`${identity.server}/backstage/api/nodes/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${identity.token}`,
          "x-opensession-node": identity.id,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        if (failures) ok("reconnected");
        failures = 0;
        return;
      }
      // 401 means the operator revoked this node; retrying forever is wrong.
      if (response.status === 401) {
        fail("this node's credential was revoked", "re-run `opensession connect`");
        process.exit(1);
      }
      failures++;
      warn(`heartbeat returned ${response.status}`);
    } catch (err) {
      failures++;
      // Transient by nature — the tailnet drops, the server restarts. Log the
      // first one and then stay quiet until it recovers.
      if (failures === 1) warn("heartbeat failed", (err as Error).message);
    }
  };

  await beat();
  setInterval(beat, HEARTBEAT_MS);
  // Hold the process open; the interval is the work.
  await new Promise<void>(() => {});
  return 0;
}

export async function nodeStatus(): Promise<number> {
  const identity = await readIdentity();
  heading("This machine");
  if (!identity) {
    info(dim("not connected to any server"));
    info(dim("  opensession connect --server <url> --code <code>"));
    return 0;
  }
  ok(`connected to ${identity.server}`, `${identity.name} (${identity.id})`);
  info(dim(`  capabilities: ${(await detectCapabilities()).join(", ") || "none detected"}`));
  return 0;
}

// ── server side: managing attached nodes ─────────────────────────────────────

/** The local server's own address, from the config this CLI can read. */
async function localApi(): Promise<string> {
  const { CONFIG_PATH } = await import("./paths");
  let host = "127.0.0.1";
  let port = 3850;
  if (existsSync(CONFIG_PATH)) {
    try {
      const config = JSON.parse(await Bun.file(CONFIG_PATH).text());
      // 0.0.0.0 is a bind address, not a destination.
      const configured = config?.server?.host;
      if (configured && configured !== "0.0.0.0") host = configured;
      if (config?.server?.port) port = Number(config.server.port);
    } catch {
      // fall through to defaults
    }
  }
  return `http://${host}:${port}/backstage/api/nodes`;
}

async function apiCall(path: string, init?: RequestInit): Promise<any | undefined> {
  const base = await localApi();
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}) as any);
      fail(`server returned ${response.status}`, body?.error ?? "");
      return undefined;
    }
    return await response.json();
  } catch (err) {
    fail("could not reach the local server", (err as Error).message);
    info(dim("  is it running? `opensession status`"));
    return undefined;
  }
}

export async function nodesPair(): Promise<number> {
  const result = await apiCall("/pair", { method: "POST" });
  if (!result) return 1;

  heading("Pairing code");
  info(`  ${bold(result.code)}`);
  info(dim(`  valid for 10 minutes, single use`));
  heading("On the machine you want to attach");
  info(dim("  curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/master/install.sh | bash"));
  info(`  opensession connect --server ${(await localApi()).replace("/backstage/api/nodes", "")} --code ${result.code}`);
  return 0;
}

export async function nodesList(): Promise<number> {
  const result = await apiCall("");
  if (!result) return 1;

  const nodes = result.nodes ?? [];
  heading("Execution nodes");
  if (!nodes.length) {
    info(dim("none attached — `opensession nodes pair` to add one"));
    return 0;
  }
  for (const node of nodes) {
    const seen = node.lastSeenAt
      ? `last seen ${new Date(node.lastSeenAt).toISOString().replace("T", " ").slice(0, 19)}Z`
      : "never connected";
    info(`${node.name}  ${dim(`${node.platform}/${node.arch}`)}`);
    info(dim(`  ${node.id}  ${node.address}  ${seen}`));
    if (node.capabilities?.length) info(dim(`  can: ${node.capabilities.join(", ")}`));
  }
  return 0;
}

export async function nodesRemove(id: string): Promise<number> {
  if (!id) {
    fail("usage: opensession nodes remove <node-id>");
    return 1;
  }
  const result = await apiCall(`/${id}`, { method: "DELETE" });
  if (!result) return 1;
  ok(`removed ${id}`, "its credential no longer authenticates");
  return 0;
}
