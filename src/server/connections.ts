/**
 * Connection status + management for the MCP servers Michael's sessions
 * run with (mcp-config.json). Targets are sanitized — never expose URL
 * query strings (they can embed tokens) or env values.
 */
import { existsSync, readFileSync, copyFileSync, watchFile } from "fs";
import { writeFileAtomic } from "./shared/atomic-write";

const HOME = process.env.HOME || "/home/ubuntu";
// mcp-config.json location. Env-overridable (BACKSTAGE_MCP_CONFIG) so
// self-hosted installs / sandbox images can relocate it (docs/sandboxes-plan.md
// Phase 0 de-hardcoding); default = this repo's checkout — unchanged when unset.
const CONFIG_PATH =
  process.env.BACKSTAGE_MCP_CONFIG ||
  `${HOME}/projects/tella-backstage/mcp-config.json`;

// Cache the parsed MCP config with file-watcher invalidation
let cachedMcpConfig: { mcpServers: Record<string, any> } | null = null;
let cacheWatcherSetUp = false;

function setupCacheWatcher() {
  if (cacheWatcherSetUp) return;
  cacheWatcherSetUp = true;
  try {
    watchFile(CONFIG_PATH, () => {
      cachedMcpConfig = null;
      console.log("[mcp-cache] config changed, invalidating cache");
    });
  } catch (e) {
    console.warn("[mcp-cache] failed to set up file watcher:", e);
  }
}

export function readMcpConfig(): { mcpServers: Record<string, any> } {
  if (!cacheWatcherSetUp) setupCacheWatcher();
  if (cachedMcpConfig) return cachedMcpConfig;

  try {
    cachedMcpConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as {
      mcpServers: Record<string, any>;
    };
  } catch {
    cachedMcpConfig = { mcpServers: {} };
  }
  return cachedMcpConfig;
}

const LINEAR_AGENT_TOKENS_PATH = `${HOME}/.linear-agent-tokens.json`;

/**
 * Overlay credentials that rotate outside this process. Linear runs as the
 * Michael bot via the linear-agent's OAuth token (actor=app, refreshed by
 * that service) so issues/comments attribute to the bot, not Michiel. When
 * the token file is missing or stale, the static header in mcp-config.json
 * (personal API key) applies instead. Read per run — never persisted back.
 */
export function withDynamicCredentials(
  servers: Record<string, any>
): Record<string, any> {
  const linear = servers.linear;
  if (!linear?.url?.includes("mcp.linear.app")) return servers;
  try {
    const tokens = JSON.parse(readFileSync(LINEAR_AGENT_TOKENS_PATH, "utf-8"));
    const t: any = Object.values(tokens)[0];
    if (t?.accessToken && (!t.expiresAt || t.expiresAt > Date.now() + 60_000)) {
      return {
        ...servers,
        linear: {
          ...linear,
          headers: { ...linear.headers, Authorization: `Bearer ${t.accessToken}` },
        },
      };
    }
  } catch {}
  return servers;
}

function writeMcpConfig(config: { mcpServers: Record<string, any> }): void {
  // Keep one backup so a bad edit is always recoverable
  try {
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  } catch {}
  writeFileAtomic(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
  cache = null;
}

export interface AddMcpInput {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Optional per-user allowlist. When set (non-empty), only sessions whose user
   * resolves (via user-mappings) to one of these people get this server's tools;
   * everyone else's runs never see it. Omitted/empty = available to every
   * session (the default). Entries can be first names, full names, emails,
   * GitHub logins, or Slack ids — matched by userMatchesAny.
   */
  allowedUsers?: string[];
}

/** Normalize an allowedUsers list: trim, drop blanks, dedupe. */
function cleanAllowedUsers(users?: string[]): string[] | undefined {
  if (!Array.isArray(users)) return undefined;
  const out = Array.from(
    new Set(users.map((u) => (u || "").trim()).filter(Boolean))
  );
  return out.length ? out : undefined;
}

export function addMcpServer(input: AddMcpInput): { ok: true } | { error: string } {
  const name = (input.name || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) {
    return { error: "Name must be alphanumeric (dashes/underscores allowed)" };
  }

  const config = readMcpConfig();
  if (config.mcpServers[name]) {
    return { error: `Server "${name}" already exists — remove it first` };
  }

  let entry: any;
  if (input.transport === "http") {
    let parsed: URL;
    try {
      parsed = new URL(input.url || "");
    } catch {
      return { error: "Invalid URL" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { error: "URL must be http(s)" };
    }
    entry = { type: "http", url: input.url };
  } else {
    const command = (input.command || "").trim();
    if (!command) return { error: "Command is required for stdio servers" };
    entry = { command };
    const args = (input.args || []).map((a) => a.trim()).filter(Boolean);
    if (args.length > 0) entry.args = args;
    const env = input.env || {};
    if (Object.keys(env).length > 0) entry.env = env;
  }

  const allowedUsers = cleanAllowedUsers(input.allowedUsers);
  if (allowedUsers) entry.allowedUsers = allowedUsers;

  config.mcpServers[name] = entry;
  writeMcpConfig(config);
  return { ok: true };
}

/**
 * Set (or clear, with an empty/undefined list) the per-user allowlist on an
 * existing MCP server. Lets you restrict a server after it's been added — e.g.
 * lock `brex` down to Michiel + Grant — without re-entering its secrets.
 */
export function setMcpAllowedUsers(
  name: string,
  allowedUsers?: string[]
): { ok: true; allowedUsers?: string[] } | { error: string } {
  const config = readMcpConfig();
  const entry = config.mcpServers[name];
  if (!entry) return { error: `Server "${name}" not found` };
  const cleaned = cleanAllowedUsers(allowedUsers);
  if (cleaned) entry.allowedUsers = cleaned;
  else delete entry.allowedUsers;
  writeMcpConfig(config);
  return { ok: true, allowedUsers: cleaned };
}

export function removeMcpServer(name: string): { ok: true } | { error: string } {
  const config = readMcpConfig();
  if (!config.mcpServers[name]) return { error: `Server "${name}" not found` };
  delete config.mcpServers[name];
  writeMcpConfig(config);
  return { ok: true };
}

export interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string; // sanitized: origin+path for http, command for stdio
  envKeys: string[];
  status: "connected" | "ready" | "needs-env" | "unreachable" | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (empty/absent = everyone). */
  allowedUsers?: string[];
}

let cache: { data: McpConnection[]; ts: number } | null = null;
const TTL = 60_000;

export async function getConnections(force = false): Promise<McpConnection[]> {
  if (!force && cache && Date.now() - cache.ts < TTL) return cache.data;

  const servers = readMcpConfig().mcpServers;
  const results = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const conn = await checkServer(name, cfg);
      const allowedUsers = cleanAllowedUsers(cfg?.allowedUsers);
      if (allowedUsers) conn.allowedUsers = allowedUsers;
      return conn;
    })
  );

  cache = { data: results, ts: Date.now() };
  return results;
}

async function checkServer(name: string, cfg: any): Promise<McpConnection> {
  const isHttp = cfg.type === "http" || cfg.type === "sse" || !!cfg.url;

  if (isHttp) {
    let target = cfg.url || "";
    try {
      const u = new URL(cfg.url);
      target = `${u.origin}${u.pathname}`;
    } catch {}

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      // Any HTTP response (incl. 401/405) means the endpoint is up;
      // MCP servers typically reject bare GETs but still answer.
      const res = await fetch(cfg.url, { method: "GET", signal: controller.signal });
      clearTimeout(timer);
      return {
        name,
        transport: "http",
        target,
        envKeys: Object.keys(cfg.env || {}),
        status: "connected",
        detail: `HTTP ${res.status}`,
      };
    } catch (e: any) {
      return {
        name,
        transport: "http",
        target,
        envKeys: Object.keys(cfg.env || {}),
        status: "unreachable",
        detail: e.name === "AbortError" ? "timeout" : (e.message || "fetch failed").slice(0, 80),
      };
    }
  }

  // stdio: verify the executable / script exists and required env is present
  const command: string = cfg.command || "";
  const args: string[] = cfg.args || [];
  const envKeys = Object.keys(cfg.env || {});
  const target = [command, ...args].join(" ");

  // Resolve what must exist on disk: absolute command, or first absolute arg
  // (covers "bun run /path/to/script.ts")
  const pathsToCheck = [command, ...args].filter((p) => p.startsWith("/"));
  const missing = pathsToCheck.find((p) => !existsSync(p));
  if (missing) {
    return { name, transport: "stdio", target, envKeys, status: "missing", detail: `not found: ${missing}` };
  }

  const missingEnv = envKeys.filter((k) => {
    const v = cfg.env?.[k];
    // Values like "${PLAIN_API_KEY}" or empty mean: must come from process env
    const isRef = typeof v === "string" && (v === "" || v.includes("${"));
    return isRef ? !process.env[k] : false;
  });
  if (missingEnv.length > 0) {
    return {
      name, transport: "stdio", target, envKeys,
      status: "needs-env",
      detail: `missing: ${missingEnv.join(", ")}`,
    };
  }

  return { name, transport: "stdio", target, envKeys, status: "ready" };
}
