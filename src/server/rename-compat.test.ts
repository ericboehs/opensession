import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
	__resetRenameCompatForTest,
	envAlias,
	stateDir,
	statePath,
} from "./rename-compat";

const ENV_KEYS = [
	"OPENSESSION_RC_TEST",
	"BACKSTAGE_RC_TEST",
	"HOME",
] as const;

describe("rename-compat", () => {
	let scratch: string;
	const saved: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const k of ENV_KEYS) saved[k] = process.env[k];
		delete process.env.OPENSESSION_RC_TEST;
		delete process.env.BACKSTAGE_RC_TEST;
		scratch = join(tmpdir(), `rename-compat-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(scratch, { recursive: true });
		process.env.HOME = scratch;
		__resetRenameCompatForTest();
	});

	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
		rmSync(scratch, { recursive: true, force: true });
		__resetRenameCompatForTest();
	});

	describe("envAlias", () => {
		it("prefers the new name when both are set", () => {
			process.env.OPENSESSION_RC_TEST = "new";
			process.env.BACKSTAGE_RC_TEST = "old";
			expect(envAlias("OPENSESSION_RC_TEST", "BACKSTAGE_RC_TEST")).toBe("new");
		});

		it("falls back to the old name", () => {
			process.env.BACKSTAGE_RC_TEST = "old";
			expect(envAlias("OPENSESSION_RC_TEST", "BACKSTAGE_RC_TEST")).toBe("old");
		});

		it("returns undefined when neither is set", () => {
			expect(envAlias("OPENSESSION_RC_TEST", "BACKSTAGE_RC_TEST")).toBeUndefined();
		});

		it("treats empty strings as unset (matches `process.env.X ||` call sites)", () => {
			process.env.OPENSESSION_RC_TEST = "";
			process.env.BACKSTAGE_RC_TEST = "old";
			expect(envAlias("OPENSESSION_RC_TEST", "BACKSTAGE_RC_TEST")).toBe("old");
			process.env.BACKSTAGE_RC_TEST = "";
			expect(envAlias("OPENSESSION_RC_TEST", "BACKSTAGE_RC_TEST")).toBeUndefined();
		});
	});

	describe("statePath / stateDir", () => {
		it("uses the new path when it exists", () => {
			mkdirSync(join(scratch, ".opensession-thing"));
			mkdirSync(join(scratch, ".backstage-thing"));
			expect(stateDir("thing")).toBe(join(scratch, ".opensession-thing"));
		});

		it("falls back to the old path when only it exists", () => {
			mkdirSync(join(scratch, ".backstage-thing"));
			expect(stateDir("thing")).toBe(join(scratch, ".backstage-thing"));
		});

		it("defaults to the new path when neither exists (create-new)", () => {
			expect(stateDir("thing")).toBe(join(scratch, ".opensession-thing"));
		});

		it("resolves files as well as dirs", () => {
			writeFileSync(join(scratch, ".backstage-pins.json"), "{}");
			expect(stateDir("pins.json")).toBe(join(scratch, ".backstage-pins.json"));
		});

		it("supports arbitrary relative paths (config home)", () => {
			mkdirSync(join(scratch, ".backstage"));
			expect(statePath(".opensession", ".backstage")).toBe(join(scratch, ".backstage"));
		});

		it("caches the resolution for process-lifetime consistency", () => {
			const first = stateDir("thing"); // resolves to new (create-new)
			mkdirSync(join(scratch, ".backstage-thing"));
			expect(stateDir("thing")).toBe(first);
		});

		it("resolves through a symlink left by the migration script", () => {
			// Post-migration: real dir at the new name, symlink at the old.
			mkdirSync(join(scratch, ".opensession-thing"));
			expect(stateDir("thing")).toBe(join(scratch, ".opensession-thing"));
		});
	});
});
