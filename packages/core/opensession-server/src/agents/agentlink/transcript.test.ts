import { describe, expect, test } from "bun:test";
import { toClientEntries } from "./transcript";

const assistant = (content: unknown) => ({
  id: "e1",
  timestamp: 1,
  message: { role: "assistant", content },
});

describe("toClientEntries", () => {
  test("keeps reasoning ahead of the answer it produced", () => {
    // pi emits thinking before text. Flattening the parts and appending
    // reasoning afterwards renders it as though the model justified itself
    // after answering.
    const rows = toClientEntries(
      assistant([
        { type: "thinking", thinking: "weighing options" },
        { type: "text", text: "Do the second one." },
      ]),
      0,
    );
    expect(rows.map((r) => [r.type, r.isReasoning ?? false])).toEqual([
      ["assistant", true],
      ["assistant", false],
    ]);
    expect(rows[0]!.content).toBe("weighing options");
  });

  test("keeps a tool call in place between two runs of text", () => {
    const rows = toClientEntries(
      assistant([
        { type: "text", text: "Checking." },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { cmd: "ls" } },
        { type: "text", text: "Done." },
      ]),
      0,
    );
    expect(rows.map((r) => r.type)).toEqual([
      "assistant",
      "tool_use",
      "assistant",
    ]);
    expect(rows[1]!.toolUseId).toBe("call-1");
  });

  test("gives every row of one message a distinct id", () => {
    // Colliding ids made each pushed turn overwrite the last one in the
    // clients, which is how a sent message could vanish after arriving.
    const rows = toClientEntries(
      assistant([
        { type: "thinking", thinking: "a" },
        { type: "text", text: "b" },
        { type: "thinking", thinking: "c" },
        { type: "text", text: "d" },
      ]),
      0,
    );
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  test("carries no content rather than inventing one for a bare tool call", () => {
    const rows = toClientEntries(
      assistant([{ type: "toolCall", id: "c1", name: "read" }]),
      0,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.content).toBe("");
    expect(rows[0]!.toolName).toBe("read");
  });

  test("still handles a plain string message", () => {
    const rows = toClientEntries(assistant("just text"), 0);
    expect(rows).toEqual([
      expect.objectContaining({ type: "assistant", content: "just text" }),
    ]);
  });

  test("pairs a tool result with the call by id", () => {
    const rows = toClientEntries(
      {
        id: "e2",
        timestamp: 1,
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: "ok",
        },
      },
      0,
    );
    expect(rows[0]!.type).toBe("tool_result");
    expect(rows[0]!.toolUseId).toBe("call-1");
  });

  test("drops a message with no role rather than guessing one", () => {
    expect(toClientEntries({ id: "x", message: {} }, 0)).toEqual([]);
  });
});
