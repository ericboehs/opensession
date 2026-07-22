import { resolve } from "path";

/** The backstage-side RPC socket the MCP proxy talks to. Stable path. */
export function rpcSocketPath(chatsDir: string): string {
	return `${chatsDir}/backstage-rpc.sock`;
}

/** Absolute paths used by Codex MCP stdio proxy config. */
export const BUN_BIN = process.execPath;
export const REPO_ROOT = resolve(import.meta.dir, "../..");
export const MCP_PROXY_ENTRY = resolve(import.meta.dir, "../runner-host/mcp-proxy.ts");
