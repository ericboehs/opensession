import { describe, expect, it } from "bun:test";
import { CTX_OPEN, CTX_CLOSE, wrapContext, stripContext } from "./prompt-context";

describe("prompt-context", () => {
  it("wraps a body in sentinels", () => {
    const w = wrapContext("system stuff");
    expect(w).toContain(CTX_OPEN);
    expect(w).toContain(CTX_CLOSE);
    expect(w).toContain("system stuff");
  });

  it("strips a fenced block, leaving only the human message", () => {
    const prompt = `${wrapContext("You are Michael in Ask mode…\n\n## Model routing\n…")}\n\nWhat were the three constraints?`;
    expect(stripContext(prompt)).toBe("What were the three constraints?");
  });

  it("strips multiple fenced blocks (preamble + handoff)", () => {
    const prompt = [
      wrapContext("SYSTEM PREAMBLE"),
      wrapContext("## Engine handoff\nrecent transcript…"),
      "the actual question",
    ].join("\n\n");
    const out = stripContext(prompt);
    expect(out).toBe("the actual question");
    expect(out).not.toContain("Engine handoff");
    expect(out).not.toContain("PREAMBLE");
  });

  it("leaves plain text untouched", () => {
    expect(stripContext("just a normal message")).toBe("just a normal message");
  });

  it("handles empty/undefined-ish input", () => {
    expect(stripContext("")).toBe("");
  });
});
