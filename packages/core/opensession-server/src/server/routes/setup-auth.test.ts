import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { handleSetupRoutes } from "./setup";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedClientId = process.env.OPENSESSION_GITHUB_CLIENT_ID;
const dirs: string[] = [];

function context(login: string): RouteContext {
	const url = new URL("http://localhost/api/setup/status");
	return {
		req: new Request(url),
		url,
		path: url.pathname,
		publicPrefix: "",
		authUser: { login, name: login },
	};
}

function roleAwareConfig(): void {
	const dir = mkdtempSync(join(tmpdir(), "opensession-setup-auth-"));
	dirs.push(dir);
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify({
		integrations: { github: { userPrAuth: true, oauthClientId: "test-client" } },
		identity: {
			team: [
				{ name: "Ada", github: "ada", admin: true },
				{ name: "Grace", github: "grace", admin: false },
			],
		},
	}));
	process.env.OPENSESSION_CONFIG = path;
	process.env.OPENSESSION_GITHUB_CLIENT_ID = "test-client";
}

afterEach(() => {
	if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
	else process.env.OPENSESSION_CONFIG = savedConfig;
	if (savedClientId === undefined) delete process.env.OPENSESSION_GITHUB_CLIENT_ID;
	else process.env.OPENSESSION_GITHUB_CLIENT_ID = savedClientId;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("workspace setup authorization", () => {
	test("rejects configured non-admin teammates", async () => {
		roleAwareConfig();
		const response = await handleSetupRoutes(context("grace"));
		expect(response?.status).toBe(403);
		expect(await response?.json()).toEqual({
			error: "Workspace administrator access is required",
		});
	});
});
