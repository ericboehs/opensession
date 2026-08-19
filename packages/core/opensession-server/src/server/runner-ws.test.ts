import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRunnerPairing, listRunners, registerRunner, removeRunner, updateRunner } from "./runners";
import { execOnRunner, runnerWsClose, runnerWsMessage, runnerWsOpen } from "./runner-ws";

const HOME = mkdtempSync(join(tmpdir(), "os-runner-ws-test-"));
const realHome = process.env.HOME;
process.env.HOME = HOME;

afterEach(() => { for (const runner of listRunners()) removeRunner(runner.id); });
afterAll(() => { process.env.HOME = realHome; rmSync(HOME, { recursive: true, force: true }); });

describe("Runner WebSocket policy", () => {
	test("blocks exec when maintenance is enabled after connection", async () => {
		const { code } = createRunnerPairing("tester");
		const registered = registerRunner({ code, name: "connected-runner", platform: "linux", arch: "x64", address: "100.101.102.103" });
		if (!registered.ok) throw new Error(registered.error);

		const sent: string[] = [];
		const ws = {
			data: { kind: "runner", runnerId: registered.runner.id },
			send: (frame: string) => sent.push(frame),
			close: () => {},
		};
		expect(runnerWsOpen(ws)).toBe(true);
		expect(runnerWsMessage(ws, JSON.stringify({ t: "hello", version: 1 }))).toBe(true);
		updateRunner(registered.runner.id, { maintenance: true });

		await expect(execOnRunner(registered.runner.id, "echo stale-policy")).rejects.toThrow("not permitted");
		expect(sent).toEqual([]);
		runnerWsClose(ws);
	});
});
