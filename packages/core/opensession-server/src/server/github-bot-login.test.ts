// When the GitHub PR agent posts on the App installation token, its comments
// are authored by "<app-slug>[bot]", not the bot PAT's login. githubBotLogins()
// must list that identity so the agent recognises its own App-posted comments
// as ours and never treats them as human replies to answer.

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { githubBotLogins } from "./config";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedBotLogin = process.env.GITHUB_BOT_LOGIN;
const dirs: string[] = [];

// The loader caches by path+mtime, so each case gets a fresh path.
function withConfig(obj: unknown): void {
	const dir = mkdtempSync(join(tmpdir(), "gh-bot-login-test-"));
	dirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(obj));
	process.env.OPENSESSION_CONFIG = path;
	delete process.env.GITHUB_BOT_LOGIN;
}

afterEach(() => {
	if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
	else process.env.OPENSESSION_CONFIG = savedConfig;
	if (savedBotLogin === undefined) delete process.env.GITHUB_BOT_LOGIN;
	else process.env.GITHUB_BOT_LOGIN = savedBotLogin;
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("githubBotLogins with a GitHub App", () => {
	test("recognises the App's <slug>[bot] author as ours (lowercased)", () => {
		withConfig({ integrations: { github: { appSlug: "Open-Session-v6a6" } } });
		expect(githubBotLogins()).toContain("open-session-v6a6[bot]");
	});

	test("no App slug configured contributes no App bot login", () => {
		withConfig({ integrations: { github: {} } });
		expect(githubBotLogins()).toEqual([]);
	});
});
