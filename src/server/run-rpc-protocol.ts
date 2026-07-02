const HOME = process.env.HOME || "/home/ubuntu";

/** The backstage-side RPC socket the MCP proxy talks to. Stable path. */
export function rpcSocketPath(chatsDir: string): string {
	return `${chatsDir}/backstage-rpc.sock`;
}

/** Absolute paths used by Codex MCP stdio proxy config. */
export const BUN_BIN = `${HOME}/.bun/bin/bun`;
export const REPO_ROOT = `${HOME}/projects/tella-backstage`;
export const MCP_PROXY_ENTRY = `${REPO_ROOT}/src/runner-host/mcp-proxy.ts`;
