import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HostHandle, type HostLauncher } from "./host-client";
import type { RunHostMeta, RunHostSpec } from "../runner-host/protocol";
import {
  TranscriptStore,
  __setTranscriptStoreForTest,
} from "./transcript-store";
import { transcriptLineUser } from "./opencode-transcript";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeHandle(spec: RunHostSpec) {
  const root = mkdtempSync(join(tmpdir(), "host-client-test-"));
  roots.push(root);
  const dir = join(root, spec.hostId);
  mkdirSync(dir);
  const launcher: HostLauncher = {
    alive: () => true,
    newRunDir: (hostId) => join(root, hostId),
    launch: async () => {},
  };
  return new HostHandle(dir, spec, {}, launcher);
}

function hello(spec: RunHostSpec, selectedModel: string) {
  return {
    t: "hello" as const,
    hostId: spec.hostId,
    pid: 1,
    osSessionId: spec.osSessionId,
    state: "running" as const,
    pendingAsks: [],
    selectedModel,
    effectiveModel: selectedModel,
    transientFallback: false,
  };
}

describe("HostHandle model recovery", () => {
	test("acknowledges a terminal event so the detached host can exit", async () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-terminal-test-"));
		roots.push(root);
		const dir = join(root, "rh-terminal");
		mkdirSync(dir);
		const sent: unknown[] = [];
		let handlers: { onMsg(msg: any): void; onClose(): void } | undefined;
		const launcher: HostLauncher = {
			alive: () => true,
			newRunDir: (hostId) => join(root, hostId),
			launch: async () => {},
			connector: () => ({
				connect: async (nextHandlers) => {
					handlers = nextHandlers;
					return {
						send: (message) => {
							sent.push(message);
							return true;
						},
						close: () => {},
					};
				},
			}),
		};
		const spec: RunHostSpec = {
			hostId: "rh-terminal",
			osSessionId: "os-terminal",
			prompt: "finish once",
			cwd: "/tmp",
		};
		const handle = new HostHandle(dir, spec, {}, launcher);
		await handle.connectWithWait(100);
		const events = handle.events();
		handlers!.onMsg({
			t: "event",
			event: { type: "done", result: "PI_SURVIVED_RESTART" },
		});
		handlers!.onMsg({
			t: "end",
			done: { type: "done", result: "PI_SURVIVED_RESTART" },
		});

		expect((await events.next()).value).toMatchObject({
			type: "done",
			result: "PI_SURVIVED_RESTART",
		});
		expect((await events.next()).done).toBe(true);
		expect(sent).toContainEqual({ t: "shutdown" });
		expect(handle.ended).toBe(true);
	});

	test("applies proxied transcript frames in the server store", () => {
		const root = mkdtempSync(join(tmpdir(), "host-client-transcript-test-"));
		roots.push(root);
		const store = new TranscriptStore(join(root, "transcripts.db"));
		const previous = __setTranscriptStoreForTest(store);
		const spec: RunHostSpec = {
			hostId: "rh-transcript",
			osSessionId: "os-transcript",
			prompt: "test",
			cwd: "/tmp",
		};
		const handle = makeHandle(spec);
		try {
			(handle as any).handleMsg({
				t: "transcript",
				engineSessionId: spec.osSessionId,
				lines: [transcriptLineUser("hello", "prompt-1")],
			});

			expect(store.readTail(spec.osSessionId, 10).entries).toMatchObject([
				{ id: "prompt-1", type: "user", content: "hello" },
			]);
		} finally {
			(handle as any).finish();
			__setTranscriptStoreForTest(previous);
		}
	});

  test("reconciles unix reconnects without duplicating reported switches", async () => {
    const spec: RunHostSpec = {
      hostId: "rh-test",
      osSessionId: "bks-test",
      prompt: "test",
      cwd: "/tmp",
      model: "model-a",
      selectedModel: "model-a",
    };
    const handle = makeHandle(spec);
    const events = handle.events();

    (handle as any).handleMsg(hello(spec, "model-a"));
    (handle as any).handleMsg({
      t: "event",
      event: {
        type: "model_switch",
        fromModel: "model-a",
        toModel: "model-b",
        switchReason: "out of credits",
        temporaryFallback: false,
      },
    });
    (handle as any).handleMsg(hello(spec, "model-b"));
    (handle as any).handleMsg(hello(spec, "model-c"));
    (handle as any).handleMsg({ t: "event", event: { type: "done", result: "ok" } });

    expect((await events.next()).value?.toModel).toBe("model-b");
    expect((await events.next()).value?.toModel).toBe("model-c");
    expect((await events.next()).value?.type).toBe("done");
    (handle as any).finish();
  });

  test("respawns with the host's latest fallback state", async () => {
    const root = mkdtempSync(join(tmpdir(), "host-client-respawn-test-"));
    roots.push(root);
    const oldDir = join(root, "rh-old");
    mkdirSync(oldDir);
    const spec: RunHostSpec = {
      hostId: "rh-old",
      osSessionId: "bks-test",
      prompt: "test",
      cwd: "/tmp",
      model: "model-a",
      selectedModel: "model-a",
    };
    let writtenSpec: RunHostSpec | undefined;
    const launcher: HostLauncher = {
      alive: () => false,
      newRunDir: (hostId) => join(root, hostId),
      writeSpec: async (_dir, nextSpec) => {
        writtenSpec = nextSpec;
      },
      launch: async () => {},
      connector: (_dir, nextSpec) => ({
        connect: async (handlers) => {
          handlers.onMsg(hello(nextSpec, nextSpec.selectedModel!));
          return { send: () => true, close: () => {} };
        },
      }),
    };
    const handle = new HostHandle(oldDir, spec, {}, launcher);
    const meta: RunHostMeta = {
      hostId: spec.hostId,
      pid: 1,
      osSessionId: spec.osSessionId,
      startedAt: new Date().toISOString(),
      selectedModel: "model-b",
      effectiveModel: "model-c",
      transientFallback: true,
    };

    await (handle as any).respawn("engine-1", meta);

    expect(writtenSpec?.selectedModel).toBe("model-b");
    expect(writtenSpec?.model).toBe("model-c");
    expect(writtenSpec?.transientFallback).toBe(true);
    (handle as any).finish();
  });
});
