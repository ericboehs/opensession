import { resolve } from "path";

/** The backstage-side RPC socket the MCP proxy talks to. Stable path. */
export function rpcSocketPath(chatsDir: string): string {
	return `${chatsDir}/backstage-rpc.sock`;
}

/** Absolute paths used by Codex MCP stdio proxy config. */
export const BUN_BIN = process.execPath;
export const REPO_ROOT = resolve(import.meta.dir, "../..");
/** The MCP stdio proxy entry. The env override exists for the bundled server
 * sidecar (os1-mac local mode): there the server is a single bundled file with
 * no src/ tree next to it, and the shell points this at the prebundled
 * mcp-proxy.js it ships alongside. Unset everywhere else. */
export const MCP_PROXY_ENTRY =
	process.env.OPENSESSION_MCP_PROXY_ENTRY?.trim() ||
	resolve(import.meta.dir, "../runner-host/mcp-proxy.ts");
