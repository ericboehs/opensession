import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { HostHandle, type HostLauncher } from "./host-client";
import type { RunHostMeta, RunHostSpec } from "../runner-host/protocol";

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
    bksSessionId: spec.bksSessionId,
    state: "running" as const,
    pendingAsks: [],
    selectedModel,
    effectiveModel: selectedModel,
    transientFallback: false,
  };
}

describe("HostHandle model recovery", () => {
  test("reconciles unix reconnects without duplicating reported switches", async () => {
    const spec: RunHostSpec = {
      hostId: "rh-test",
      bksSessionId: "bks-test",
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
      bksSessionId: "bks-test",
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
      bksSessionId: spec.bksSessionId,
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
