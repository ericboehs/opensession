import { describe, expect, it } from "bun:test";
import {
  CTX_OPEN,
  CTX_CLOSE,
  wrapContext,
  stripContext,
  isContextOnly,
} from "./prompt-context";
import { AUTO_CONTINUE_PROMPT, AUTO_CONTINUE_USER } from "./auto-continue";

describe("prompt-context", () => {
  it("wraps a body in sentinels", () => {
    const w = wrapContext("system stuff");
    expect(w).toContain(CTX_OPEN);
    expect(w).toContain(CTX_CLOSE);
    expect(w).toContain("system stuff");
  });

  it("strips a fenced block, leaving only the human message", () => {
    const prompt = `${wrapContext("You are an assistant in Ask mode…\n\n## Model routing\n…")}\n\nWhat were the three constraints?`;
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

  // An all-context prompt used to leave its "[Name] " delivery attribution as
  // the entire transcript entry, which rendered as a bare identity dot labelled
  // "auto-continue" above the next message (2026-07-30).
  it("treats a leftover delivery attribution as nothing to show", () => {
    const delivered = `[${AUTO_CONTINUE_USER}] ${wrapContext(AUTO_CONTINUE_PROMPT)}`;
    expect(stripContext(delivered)).toBe("");
    expect(isContextOnly(delivered)).toBe(true);
  });

  it("keeps the attribution when the human actually said something", () => {
    const delivered = `[Kent] ${wrapContext("handoff")}\n\nrebase this`;
    expect(stripContext(delivered)).toBe("[Kent] rebase this");
    expect(isContextOnly(delivered)).toBe(false);
  });

  it("isContextOnly ignores unfenced text and blanks", () => {
    expect(isContextOnly("just a normal message")).toBe(false);
    expect(isContextOnly("")).toBe(false);
    expect(isContextOnly(wrapContext("only plumbing"))).toBe(true);
  });
});

it("strips the pre-rename backstage fence pair (old transcripts)", () => {
	const text = "<backstage:context>\nplumbing\n</backstage:context>\nreal message";
	expect(stripContext(text)).toBe("real message");
});
