import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listPortalServices, listSandboxPortalServices, readPortalRegistry, reapOrphanedPortalServices, setPortalPath, startPortalService, startSandboxPortalService, stopPortalService, stopSandboxPortalService } from "./portal-supervisor";
import type { Sandbox } from "./sandbox/provider";

let worktree = "";

beforeEach(() => { worktree = mkdtempSync(join(tmpdir(), "os-portals-test-")); });
afterAll(() => { if (worktree) rmSync(worktree, { recursive: true, force: true }); });

describe("session Portal supervisor", () => {
	test("keeps generated portal metadata and ports together in .ports.conf", () => {
		writeFileSync(join(worktree, ".ports.conf"), "WEBAPP_PORT=3300\n");
		const record = { name: "api", key: "PORTAL_API_PORT", command: "bun run api", port: 4200, state: "stopped" as const };
		writeFileSync(join(worktree, ".ports.conf"), `${PREFIX(record)}\nPORTAL_API_PORT=4200\nWEBAPP_PORT=3300\n`);
		setPortalPath(worktree, "/health", "api");
		const [portal] = readPortalRegistry(worktree);
		expect(portal).toMatchObject({ name: "api", key: "PORTAL_API_PORT", port: 4200, defaultPath: "/health" });
		expect(Bun.file(join(worktree, ".ports.conf")).text()).resolves.toContain("WEBAPP_PORT=3300");
	});

	test("starts, verifies, and stops only its own process group", async () => {
		const port = 18_701;
		process.env.PORTAL_SUPERVISOR_TEST_SECRET = "must-not-reach-portal";
		const portal = await startPortalService({
			sessionId: "os-portal-test", worktreeDir: worktree, name: "test-app", port,
			command: "bun -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response(process.env.PORTAL_SUPERVISOR_TEST_SECRET || \"ok\")}})'",
		});
		expect(portal.state).toBe("awake");
		expect(portal.url).toContain(`:${port + 6000}`);
		expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("ok");
		expect((await listPortalServices(worktree))[0]?.state).toBe("awake");
		await stopPortalService({ sessionId: "os-portal-test", worktreeDir: worktree, name: "test-app" });
		delete process.env.PORTAL_SUPERVISOR_TEST_SECRET;
		expect((await listPortalServices(worktree))[0]?.state).toBe("stopped");
	});

	test("reaps a Portal whose durable owner no longer owns the worktree", async () => {
		const port = 18_703;
		await startPortalService({
			sessionId: "deleted-session", worktreeDir: worktree, name: "orphan", port,
			command: "bun -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response(\"orphan\")}})'",
		});
		expect(readPortalRegistry(worktree)[0]).toMatchObject({ sessionId: "deleted-session", state: "awake" });
		expect((await reapOrphanedPortalServices([
			{ id: "deleted-session", worktreeDir: worktree, attachedRepos: [] },
		])).stopped).toEqual([]);
		expect((await listPortalServices(worktree))[0]?.state).toBe("awake");

		const result = await reapOrphanedPortalServices([
			{ id: "replacement-session", worktreeDir: worktree, attachedRepos: [] },
		]);
		expect(result.stopped).toEqual([
			expect.objectContaining({ sessionId: "deleted-session", worktreeDir: worktree, name: "orphan" }),
		]);
		expect((await listPortalServices(worktree))[0]?.state).toBe("stopped");
	});

	test("supervises a Portal through the Sandbox execution boundary", async () => {
		const sandbox = sandboxFor(worktree, 18_702);
		const portal = await startSandboxPortalService({
			sessionId: "os-sandbox-portal-test", sandbox, name: "remote-app", port: 18_702,
			command: "bun -e 'Bun.serve({port:Number(process.env.PORT),fetch(){return new Response(\"sandbox\")}})'",
		});
		expect(portal.state).toBe("awake");
		expect(await (await fetch("http://127.0.0.1:18702")).text()).toBe("sandbox");
		expect((await listSandboxPortalServices(sandbox))[0]).toMatchObject({ name: "remote-app", state: "awake" });
		await stopSandboxPortalService({ sessionId: "os-sandbox-portal-test", sandbox, name: "remote-app" });
		expect((await listSandboxPortalServices(sandbox))[0]?.state).toBe("stopped");
	});
});

function PREFIX(record: unknown): string { return `# opensession-portal ${JSON.stringify(record)}`; }

function sandboxFor(cwd: string, port: number): Sandbox {
	return {
		id: "sandbox-portal-test", provider: "docker", cwd,
		async exec(command) {
			const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" });
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
			]);
			return { exitCode, stdout, stderr };
		},
		launchRun: () => { throw new Error("not used"); },
		async ports() { return { [port]: port }; },
		async status() { return "running"; },
	};
}
