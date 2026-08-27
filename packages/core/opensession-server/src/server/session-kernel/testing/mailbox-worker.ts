import { SESSION_KERNEL_ACTOR_VERSION } from "../actor-protocol";

self.addEventListener("message", (event: MessageEvent<Record<string, any>>) => {
  const request = event.data;
  if (request.t === "hello") {
    self.postMessage({
      t: "ready",
      rpcId: request.rpcId,
      version: SESSION_KERNEL_ACTOR_VERSION,
    });
    return;
  }
  if (request.t === "call") {
    setTimeout(() => {
      const body = JSON.stringify({ ok: true, result: undefined });
      self.postMessage({
        t: "call_result",
        rpcId: request.rpcId,
        status: 1,
        length: Buffer.byteLength(body),
        body,
      });
    }, 50);
    return;
  }
  self.postMessage({
    t: "error",
    rpcId: request.rpcId,
    error: `Unexpected test request ${String(request.t)}`,
  });
});
