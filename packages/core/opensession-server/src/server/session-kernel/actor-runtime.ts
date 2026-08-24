import { SessionKernelActorClient } from "./actor-client";
import { installSessionKernelActor } from "./kernel";
import { setServiceReadiness } from "../service-readiness";
import { workerEntry } from "../../runner-host/exe";

type ActorRuntimeState = {
  client?: SessionKernelActorClient;
  starting?: Promise<void>;
};
const globalActor = globalThis as typeof globalThis & {
  __opensessionSessionKernelActor?: ActorRuntimeState;
};
const runtime = (globalActor.__opensessionSessionKernelActor ??= {});

/**
 * The kernel runs in a real Worker thread: the client blocks on Atomics.wait
 * against a SharedArrayBuffer the worker fills, so neither an in-process port
 * nor a subprocess can stand in for it. `bun build --compile` does not embed
 * Worker entry points, so a compiled binary loads the worker from a sibling
 * `session-kernel-worker.js` shipped beside the executable (scripts/build-
 * compile.ts stages it next to the sharp sidecar). A source checkout runs the
 * TypeScript entry directly.
 */
function sessionKernelWorkerUrl(): string | URL {
  return workerEntry("session-kernel-worker.js", new URL("../../session-kernel-worker.ts", import.meta.url).href);
}

/** Start the authoritative actor before the gateway hydrates mutable session state. */
export function startSessionKernelActor(): Promise<void> {
  if (runtime.client) return Promise.resolve();
  if (runtime.starting) return runtime.starting;
  runtime.starting = (async () => {
    const worker = new Worker(sessionKernelWorkerUrl(), { type: "module" });
    const client = new SessionKernelActorClient(worker, (error) => {
      setServiceReadiness("failed", error);
      console.error("[session-kernel] authoritative actor failed; stopping gateway:", error);
      process.exitCode = 1;
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 0).unref?.();
      setTimeout(() => process.exit(1), 5_000).unref?.();
    });
    try {
      await client.hello();
      runtime.client = client;
      installSessionKernelActor(client);
    } catch (error) {
      client.terminate();
      throw error;
    } finally {
      runtime.starting = undefined;
    }
  })();
  return runtime.starting;
}

export function stopSessionKernelActor(): void {
  const client = runtime.client;
  runtime.client = undefined;
  installSessionKernelActor(undefined);
  client?.terminate();
}
