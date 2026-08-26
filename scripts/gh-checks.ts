#!/usr/bin/env bun

import { githubAppEnv } from "../packages/core/opensession-server/src/server/github-app";

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: bun scripts/gh-checks.ts <pr> [gh pr checks options]");
  process.exit(2);
}

const appEnv = await githubAppEnv();
if (!appEnv) {
  console.error("GitHub App installation token unavailable");
  process.exit(1);
}

const child = Bun.spawn(["gh", "pr", "checks", ...args], {
  env: { ...process.env, ...appEnv },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

process.exit(await child.exited);
