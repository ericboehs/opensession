import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSetupRoutes } from "./setup";
import type { RouteContext } from "./context";

const savedConfig = process.env.OPENSESSION_CONFIG;
const dirs: string[] = [];

function request(method: "GET" | "PUT", body?: unknown): RouteContext {
	const url = new URL("http://localhost/api/setup/onboarding");
	return {
		req: new Request(url, {
			method,
			...(body === undefined
				? {}
				: {
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body),
					}),
		}),
		url,
		path: url.pathname,
		publicPrefix: "",
		authUser: { login: "admin", name: "Admin" },
	};
}

afterEach(() => {
	if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
	else process.env.OPENSESSION_CONFIG = savedConfig;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("instance onboarding flag", () => {
	test("treats an existing pre-flag instance as already onboarded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "opensession-onboarding-legacy-"));
		dirs.push(dir);
		process.env.OPENSESSION_CONFIG = join(dir, "config.json");

		const response = await handleSetupRoutes(request("GET"));
		expect(await response?.json()).toEqual({ completed: true });
	});

	test("stays required until the final action explicitly completes it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "opensession-onboarding-"));
		dirs.push(dir);
		const config = join(dir, "config.json");
		writeFileSync(config, JSON.stringify({ onboardingCompleted: false }));
		process.env.OPENSESSION_CONFIG = config;

		const before = await handleSetupRoutes(request("GET"));
		expect(await before?.json()).toEqual({ completed: false });

		const completed = await handleSetupRoutes(request("PUT", { completed: true }));
		expect(completed?.status).toBe(200);
		expect(await completed?.json()).toEqual({ completed: true });
		expect(JSON.parse(readFileSync(config, "utf8")).onboardingCompleted).toBe(true);

		const after = await handleSetupRoutes(request("GET"));
		expect(await after?.json()).toEqual({ completed: true });
	});
});
