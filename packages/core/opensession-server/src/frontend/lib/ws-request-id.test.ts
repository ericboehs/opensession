import { describe, expect, test } from "bun:test";
import { withMutationRequestId } from "./ws-request-id";

describe("WebSocket mutation request ids", () => {
  test("stamps session mutations before reconnect buffering", () => {
    const message = withMutationRequestId({
      type: "prompt",
      sessionId: "s1",
      content: "hello",
    });
    expect("requestId" in message && message.requestId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(withMutationRequestId(message)).toBe(message);
  });

  test("stamps create intents before a session id exists", () => {
    const message = withMutationRequestId({
      type: "create_session",
      branch: "feature",
      prompt: "build it",
      user: "Ada",
    });
    expect("requestId" in message && message.requestId).toBeString();
  });

  test("does not stamp read or presence frames", () => {
    const message = { type: "watch", sessionId: "s1" } as const;
    expect(withMutationRequestId(message)).toBe(message);
  });
});
