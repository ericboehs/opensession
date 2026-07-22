import { describe, expect, test } from "bun:test";
import type { WorkspaceExec } from "../sandbox";
import {
	__materializeMacosBaseImageForTest,
	isMissingMacosAssetError,
} from "./session-git";

function fakeExec(exitCode = 0) {
	const calls: string[][] = [];
	const exec = (async (command: string[]) => {
		calls.push(command);
		return { exitCode, stdout: "", stderr: "" };
	}) as WorkspaceExec;
	return { calls, exec };
}

describe("remote worktree images", () => {
	test("removes a temporary base image when materialization fails", async () => {
		const { calls, exec } = fakeExec(1);

		const result = await __materializeMacosBaseImageForTest(exec, "base:image.png", async () => {
			throw new Error("reader should not run");
		});

		expect(result).toBeNull();
		expect(calls).toHaveLength(2);
		expect(calls[1].slice(0, 4)).toEqual(["rm", "-f", "--", calls[0][5]]);
	});

	test("removes a temporary base image when streaming fails", async () => {
		const { calls, exec } = fakeExec();

		await expect(
			__materializeMacosBaseImageForTest(exec, "base:image.png", async () => {
				throw new Error("stream failed");
			}),
		).rejects.toThrow("stream failed");
		expect(calls).toHaveLength(2);
		expect(calls[1].slice(0, 4)).toEqual(["rm", "-f", "--", calls[0][5]]);
	});

	test("recognizes a missing remote asset for a 404 response", () => {
		expect(
			isMissingMacosAssetError(
				new Error("remote asset not found in the session workspace: image.png"),
			),
		).toBe(true);
		expect(isMissingMacosAssetError(new Error("ssh transport failed"))).toBe(false);
	});
});
