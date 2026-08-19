import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { RouteContext } from "./context";
import { handleInstanceSettingsRoutes } from "./instance-settings";
import { handleStaticAssetsRoutes } from "./static-assets";

const saved = {
	config: process.env.OPENSESSION_CONFIG,
	state: process.env.OPENSESSION_STATE_DIR,
	clientId: process.env.OPENSESSION_GITHUB_CLIENT_ID,
};
const dirs: string[] = [];

function seed(): { root: string; config: string } {
	const root = mkdtempSync(join(tmpdir(), "opensession-instance-settings-"));
	dirs.push(root);
	const config = join(root, "config.json");
	writeFileSync(
		config,
		JSON.stringify({
			branding: { productName: "Open Session" },
			future: { keep: true },
			integrations: {
				github: { userPrAuth: true, oauthClientId: "test-client" },
			},
			identity: {
				team: [
					{ name: "Ada", github: "ada", admin: true },
					{ name: "Grace", github: "grace", admin: false },
				],
			},
		}),
	);
	process.env.OPENSESSION_CONFIG = config;
	process.env.OPENSESSION_STATE_DIR = root;
	process.env.OPENSESSION_GITHUB_CLIENT_ID = "test-client";
	return { root, config };
}

function context(
	path: string,
	method = "GET",
	opts: { login?: string; body?: unknown; bytes?: Uint8Array } = {},
): RouteContext {
	const url = new URL(`http://localhost${path}`);
	return {
		req: new Request(url, {
			method,
			...(opts.bytes
				? {
						body: opts.bytes.slice().buffer as ArrayBuffer,
						headers: { "Content-Type": "image/png" },
					}
				: opts.body !== undefined
					? {
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(opts.body),
						}
					: {}),
		}),
		url,
		path,
		publicPrefix: "",
		authUser: opts.login
			? { login: opts.login, name: opts.login }
			: null,
	};
}

function squarePngHeader(side = 256): Uint8Array {
	const bytes = new Uint8Array(24);
	bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
	bytes.set([73, 72, 68, 82], 12);
	for (const offset of [16, 20]) {
		bytes[offset] = (side >>> 24) & 0xff;
		bytes[offset + 1] = (side >>> 16) & 0xff;
		bytes[offset + 2] = (side >>> 8) & 0xff;
		bytes[offset + 3] = side & 0xff;
	}
	return bytes;
}

afterEach(() => {
	for (const [key, value] of [
		["OPENSESSION_CONFIG", saved.config],
		["OPENSESSION_STATE_DIR", saved.state],
		["OPENSESSION_GITHUB_CLIENT_ID", saved.clientId],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("instance general settings", () => {
	test("writes the organization name and preserves unrelated config", async () => {
		const { config } = seed();
		const response = await handleInstanceSettingsRoutes(
			context("/api/settings/general", "PUT", {
				login: "ada",
				body: { organizationName: " Acme " },
			}),
		);
		expect(response?.status).toBe(200);
		expect((await response?.json()).organizationName).toBe("Acme");
		const stored = JSON.parse(readFileSync(config, "utf-8"));
		expect(stored.organization).toEqual({ name: "Acme" });
		expect(stored.future).toEqual({ keep: true });
	});

	test("rejects shared-setting writes from non-admin teammates", async () => {
		const { config } = seed();
		for (const path of ["/api/settings/general", "/api/settings/identity"]) {
			const response = await handleInstanceSettingsRoutes(
				context(path, "PUT", {
					login: "grace",
					body: path.endsWith("general")
						? { organizationName: "Nope" }
						: { productName: "Nope" },
				}),
			);
			expect(response?.status).toBe(403);
		}
		expect(JSON.parse(readFileSync(config, "utf-8")).organization).toBeUndefined();
	});

	test("stores, serves, and removes the organization icon", async () => {
		seed();
		const bytes = squarePngHeader();
		const upload = await handleInstanceSettingsRoutes(
			context("/api/settings/general/icon", "POST", { login: "ada", bytes }),
		);
		const uploaded = await upload?.json();
		expect(upload?.status).toBe(200);
		expect(uploaded.organizationIconUrl).toMatch(
			/^\/organization-icon\.png\?v=[a-f0-9]{12}$/,
		);

		const asset = await handleStaticAssetsRoutes(
			context("/organization-icon.png"),
		);
		expect(asset?.status).toBe(200);
		expect(asset?.headers.get("Content-Type")).toBe("image/png");
		expect(Array.from(new Uint8Array(await asset!.arrayBuffer()))).toEqual(
			Array.from(bytes),
		);

		const removed = await handleInstanceSettingsRoutes(
			context("/api/settings/general/icon", "DELETE", { login: "ada" }),
		);
		expect((await removed?.json()).organizationIconUrl).toBeNull();
		expect(
			(await handleStaticAssetsRoutes(context("/organization-icon.png")))?.status,
		).toBe(404);
	});

	test("rejects non-square or oversized icon dimensions", async () => {
		seed();
		const bytes = squarePngHeader(4096);
		const response = await handleInstanceSettingsRoutes(
			context("/api/settings/general/icon", "POST", { login: "ada", bytes }),
		);
		expect(response?.status).toBe(400);
		expect((await response?.json()).error).toContain("square icon");
	});

	test("rejects oversized icon bodies before storing them", async () => {
		seed();
		const response = await handleInstanceSettingsRoutes(
			context("/api/settings/general/icon", "POST", {
				login: "ada",
				bytes: new Uint8Array(4 * 1024 * 1024 + 1),
			}),
		);
		expect(response?.status).toBe(413);
		expect((await response?.json()).error).toContain("4 MB");
	});
});
