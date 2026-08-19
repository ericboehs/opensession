import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { SlackSession } from "./state";

// state.ts resolves SESSION_DIR at import, so redirect the state dir first.
const scratch = mkdtempSync(join(tmpdir(), "opensession-slack-state-"));
const previousStateDir = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;

const {
	SESSION_DIR,
	loadSession,
	saveSession,
	getSessionKey,
	loadGithubDeliveries,
	isGithubDeliveryProcessed,
	markGithubDeliveryProcessed,
} = await import("./state");
const { writeJsonAtomic } = await import("../../server/shared/atomic-write");

afterAll(() => {
	if (previousStateDir === undefined) delete process.env.OPENSESSION_STATE_DIR;
	else process.env.OPENSESSION_STATE_DIR = previousStateDir;
	rmSync(scratch, { recursive: true, force: true });
});

function session(patch: Partial<SlackSession> = {}): SlackSession {
	return {
		channel: "C1",
		threadTs: "1700000000.000100",
		userId: "U1",
		claudeSessionId: null,
		worktreeDir: null,
		branch: null,
		createdAt: new Date().toISOString(),
		lastActivity: new Date().toISOString(),
		...patch,
	} as SlackSession;
}

describe("saveSession", () => {
	test("round-trips repoId", async () => {
		const s = session({ threadTs: "1.1", repoId: "opensession" });
		await saveSession(s);
		const loaded = await loadSession(getSessionKey(s.channel, s.threadTs));
		expect(loaded?.repoId).toBe("opensession");
	});

	test("keeps fields written by other writers, e.g. piSessionId", async () => {
		const s = session({ threadTs: "2.2" });
		const key = getSessionKey(s.channel, s.threadTs);
		writeJsonAtomic(`${SESSION_DIR}/${key}.json`, {
			channel: s.channel,
			threadTs: s.threadTs,
			piSessionId: "pi-abc",
			message: "written by wt new-slack",
		});

		// The in-memory session has no piSessionId slot filled — the old
		// projection write dropped the key here.
		await saveSession(s);

		const loaded = await loadSession(key);
		expect(loaded?.piSessionId).toBe("pi-abc");
		expect((loaded as any).message).toBe("written by wt new-slack");
	});

	test("an undefined in-memory field doesn't erase the stored one, null does", async () => {
		const s = session({ threadTs: "3.3", model: "opencode/anthropic/claude-opus-5" });
		const key = getSessionKey(s.channel, s.threadTs);
		await saveSession(s);
		await saveSession(session({ threadTs: "3.3", claudeSessionId: null }));
		const loaded = await loadSession(key);
		expect(loaded?.model).toBe("opencode/anthropic/claude-opus-5");
		expect(loaded?.claudeSessionId).toBeNull();
	});
});

describe("GitHub delivery replay protection", () => {
	test("persists delivery ids and restores them after a reload", () => {
		const deliveryId = "github-delivery-persists";
		markGithubDeliveryProcessed(deliveryId);
		expect(isGithubDeliveryProcessed(deliveryId)).toBe(true);

		// loadGithubDeliveries clears the in-memory map first, mirroring a restart.
		loadGithubDeliveries();
		expect(isGithubDeliveryProcessed(deliveryId)).toBe(true);
	});

	test("drops expired delivery ids when restoring the persistent store", () => {
		writeJsonAtomic(`${SESSION_DIR}/github-deliveries.json`, [["expired-delivery", 0]], false);
		loadGithubDeliveries();
		expect(isGithubDeliveryProcessed("expired-delivery")).toBe(false);
	});
});
