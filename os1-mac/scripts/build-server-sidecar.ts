#!/usr/bin/env bun
/**
 * Build the bundled OpenSession server sidecar for the Electron shell.
 *
 * The output (build/vendor/server/, packaged as Contents/Resources/server) is
 * what local mode runs when no source checkout exists (src/local-server.js):
 *
 * - opensession.js — the whole server bundled to a single bun-target file.
 *   import.meta.dir survives bundling as the output file's directory, so the
 *   runner's plugin-path joins land on the plugin copies below, and
 *   Bun.resolveSync of the bridge packages walks the sidecar's node_modules.
 * - mcp-proxy.js — the MCP stdio proxy, prebundled; the shell points
 *   OPENSESSION_MCP_PROXY_ENTRY at it (its source-relative default resolves
 *   into a src/ tree the sidecar does not have).
 * - opencode-plugin-session-tag.js / opencode-plugin-arg-coerce.js — loaded
 *   by opencode as real files, copied verbatim.
 * - node_modules — only the Meridian bridge packages, installed from a
 *   minimal package.json pinned to the repo root's versions. Postinstalls
 *   stay blocked, matching the repo install the hosted server runs from.
 *
 * The frontend is NOT built or bundled — the local profile proxies the hosted
 * app shell — so .html imports are stubbed out.
 *
 * Run this on the platform the app targets (CI: the macOS release runner) so
 * the sidecar's node_modules pick up the right native binaries (libsql et
 * al), with the repository root's dependencies installed first (the bundler
 * resolves the server's imports from them).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const OS1_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(OS1_ROOT, "..");
const OUT = join(OS1_ROOT, "build", "vendor", "server");

if (!existsSync(join(REPO_ROOT, "node_modules", "@modelcontextprotocol"))) {
  throw new Error("Repository dependencies are missing - run bun install at the repository root first.");
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const stubHtml = {
  name: "stub-html",
  setup(build: any) {
    build.onLoad({ filter: /\.html$/ }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

async function bundle(entry: string, outName: string): Promise<void> {
  const tmp = join(OUT, `.build-${outName}`);
  const result = await Bun.build({
    entrypoints: [join(REPO_ROOT, entry)],
    outdir: tmp,
    target: "bun",
    format: "esm",
    sourcemap: "none",
    plugins: [stubHtml],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `bundle failed: ${entry}`);
  }
  const entryOut = result.outputs.find((o) => o.kind === "entry-point");
  if (!entryOut) throw new Error(`bundle produced no entry point: ${entry}`);
  for (const output of result.outputs) {
    const dest =
      output === entryOut ? join(OUT, outName) : join(OUT, relative(tmp, output.path));
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(output.path, dest);
  }
  rmSync(tmp, { recursive: true, force: true });
}

await bundle("opensession.ts", "opensession.js");
await bundle("src/runner-host/mcp-proxy.ts", "mcp-proxy.js");

for (const plugin of ["opencode-plugin-session-tag.js", "opencode-plugin-arg-coerce.js"]) {
  cpSync(join(REPO_ROOT, "src", "server", plugin), join(OUT, plugin));
}

// The bridge packages the runner resolves at run time. Versions come from the
// repo root so the sidecar can never drift from what the hosted server runs.
const repoPkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8"));
const bridgePackages = [
  "opencode-with-claude",
  "@rynfar/meridian",
  "@rynfar/meridian-plugin-opencode-scrub",
];
const dependencies: Record<string, string> = {};
for (const name of bridgePackages) {
  const version = repoPkg.dependencies?.[name];
  if (!version) throw new Error(`${name} is missing from the repository dependencies`);
  dependencies[name] = version;
}
writeFileSync(
  join(OUT, "package.json"),
  JSON.stringify(
    {
      name: "os1-server-sidecar",
      version: repoPkg.version || "0.0.0",
      private: true,
      dependencies,
    },
    null,
    2,
  ) + "\n",
);

const install = Bun.spawnSync([process.execPath, "install", "--production"], {
  cwd: OUT,
  stdout: "inherit",
  stderr: "inherit",
});
if (install.exitCode !== 0) throw new Error("bun install failed in the sidecar");

// Prune the Claude Code / Agent SDK native platform packages (~250 MB each):
// they are the SDK's FALLBACK executable resolution, tried in a try/catch that
// degrades to null when absent. Local mode never reaches that fallback — the
// runner always passes the user's own Claude install via MERIDIAN_CLAUDE_PATH
// (opencode-runner.ts sets it from CLAUDE_CODE_BIN, and the local profile
// refuses to boot without that binary), so shipping a second full Claude Code
// would only bloat the app bundle.
const anthropicDir = join(OUT, "node_modules", "@anthropic-ai");
if (existsSync(anthropicDir)) {
  const { readdirSync } = await import("node:fs");
  for (const entry of readdirSync(anthropicDir)) {
    if (/^claude-(code|agent-sdk)-.+/.test(entry)) {
      rmSync(join(anthropicDir, entry), { recursive: true, force: true });
      console.log(`[sidecar] pruned @anthropic-ai/${entry}`);
    }
  }
}

// Sanity: the exact resolutions the runner performs at run time.
Bun.resolveSync("opencode-with-claude", OUT);
Bun.resolveSync("@rynfar/meridian", OUT);
Bun.resolveSync("@rynfar/meridian-plugin-opencode-scrub", OUT);
for (const file of ["opensession.js", "mcp-proxy.js", "opencode-plugin-session-tag.js"]) {
  if (!existsSync(join(OUT, file))) throw new Error(`sidecar is missing ${file}`);
}

const serverKb = Math.round(statSync(join(OUT, "opensession.js")).size / 1024);
console.log(`[sidecar] built ${OUT} (opensession.js ${serverKb} KB)`);
