import { describe, expect, test } from "bun:test";
import {
  declaredRunFailure,
  describeUsageLimitReset,
  hasRunStatusDeclaration,
  isClaudeBridgeLaunchError,
  isClaudeUsageLimitError,
  isClaudeMalformedTerminalError,
  isProviderOverloadError,
  isTransientRunError,
  isUpstreamIdleStallError,
  usageLimitResetAt,
} from "./runner-shared";

describe("isClaudeUsageLimitError", () => {
  test("recognizes provider notices before they leak into streamed output", () => {
    expect(
      isClaudeUsageLimitError(
        "You've reached your Fable 5 limit. Switch to another model to continue.",
        false,
      ),
    ).toBe(true);
    expect(
      isClaudeUsageLimitError(
        "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
        false,
      ),
    ).toBe(true);
  });
});

describe("isClaudeBridgeLaunchError", () => {
  test("matches the two shapes the agent SDK emits", () => {
    expect(
      isClaudeBridgeLaunchError(
        "Claude Code native binary at /home/ubuntu/projects/opensession/node_modules/.bin/claude exists but failed to launch.",
      ),
    ).toBe(true);
    expect(
      isClaudeBridgeLaunchError(
        "Claude Code native binary not found at /opt/claude. Please ensure Claude Code is installed via native installer.",
      ),
    ).toBe(true);
  });

  test("does not claim faults that belong to another recovery lane", () => {
    // Usage limits and subscription faults are account-level and own their own
    // (much longer) sideline; a model's own words about a launch must never
    // wedge the account either.
    expect(isClaudeBridgeLaunchError("Claude AI usage limit reached")).toBe(false);
    expect(
      isClaudeBridgeLaunchError("Claude Max subscription issue. Check your subscription status."),
    ).toBe(false);
    expect(isClaudeBridgeLaunchError("the deploy script failed to launch the server")).toBe(false);
    expect(isClaudeBridgeLaunchError("command not found: claude")).toBe(false);
    expect(isClaudeBridgeLaunchError("")).toBe(false);
  });
});

describe("isUpstreamIdleStallError", () => {
  test("matches Meridian's idle-guard kill", () => {
    // The exact shape from the 2026-08-03 bks-019fc819 incident.
    expect(isUpstreamIdleStallError("Upstream stalled: no data for 160090ms")).toBe(true);
    expect(
      isUpstreamIdleStallError("AI_APICallError: Upstream stalled: no data for 91150ms"),
    ).toBe(true);
  });

  test("does not match other stalls or provider errors", () => {
    expect(isUpstreamIdleStallError("Claude AI usage limit reached")).toBe(false);
    expect(isUpstreamIdleStallError("upstream timeout while connecting")).toBe(false);
    expect(isUpstreamIdleStallError("no data received")).toBe(false);
    expect(isUpstreamIdleStallError("")).toBe(false);
  });
});

describe("isClaudeMalformedTerminalError", () => {
  test("matches Claude's malformed user-terminal diagnostic", () => {
    expect(
      isClaudeMalformedTerminalError(
        "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null\n" +
          "Subprocess stderr: Warning: Custom betas are only available for API key users. Ignoring provided betas.",
      ),
    ).toBe(true);
    expect(
      isTransientRunError(
        "Claude Code returned an error result: [ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null",
      ),
    ).toBe(true);
  });

  test("does not mistake normal Claude errors or model text for the diagnostic", () => {
    expect(isClaudeMalformedTerminalError("Claude Code returned an error result: You've hit your weekly limit")).toBe(false);
    expect(isClaudeMalformedTerminalError("Please explain the ede_diagnostic field")).toBe(false);
    expect(isClaudeMalformedTerminalError("")).toBe(false);
  });
});

describe("status-poll watchdog failures", () => {
  test("recover through the bounded engine continuation path", () => {
    expect(
      isTransientRunError(
        "opencode server stopped answering status polls and refused a health probe — ending the turn " +
          "(engine state preserved; send again to continue)",
      ),
    ).toBe(true);
    expect(
      isTransientRunError(
        "opencode server answered health probes but was too starved to serve status for 10 minutes — " +
          "ending the turn (engine state preserved; send again to continue)",
      ),
    ).toBe(true);
  });

  test("does not treat ordinary poll wording as an engine failure", () => {
    expect(isTransientRunError("the model says status polls are useful")).toBe(false);
    expect(isTransientRunError("health probe results are ready")).toBe(false);
  });
});

describe("isProviderOverloadError", () => {
  test("matches provider-declared overloads", () => {
    expect(isProviderOverloadError("Our servers are currently overloaded. Please try again later.")).toBe(true);
    expect(isProviderOverloadError("overloaded_error")).toBe(true);
  });

  test("does not match unrelated transient failures", () => {
    expect(isProviderOverloadError("socket hang up")).toBe(false);
    expect(isProviderOverloadError("OpenAI usage limit reached")).toBe(false);
  });
});

describe("declaredRunFailure", () => {
  test("a failed declaration is returned with its reason, last line wins", () => {
    expect(declaredRunFailure("summary…\nSCAN STATUS: failed — claude CLI auth failure")).toBe(
      "SCAN STATUS: failed — claude CLI auth failure",
    );
    expect(declaredRunFailure("RUN STATUS: failed — dry pool")).toBe("RUN STATUS: failed — dry pool");
    // A closing ok clears an earlier quoted/failed line.
    expect(
      declaredRunFailure("SCAN STATUS: failed — transient\nretried fine\nSCAN STATUS: ok"),
    ).toBeNull();
  });

  test("ok, absent, and mid-line mentions do not declare failure", () => {
    expect(declaredRunFailure("all good\nSCAN STATUS: ok")).toBeNull();
    expect(declaredRunFailure("no status here")).toBeNull();
    // Not line-anchored ⇒ not a declaration (e.g. quoting the instruction).
    expect(declaredRunFailure("end with `SCAN STATUS: failed — <reason>` on errors")).toBeNull();
  });
});

describe("hasRunStatusDeclaration", () => {
  test("line-anchored status lines only", () => {
    expect(hasRunStatusDeclaration("done\nSCAN STATUS: ok")).toBe(true);
    expect(hasRunStatusDeclaration("done\nRUN STATUS: failed — x")).toBe(true);
    expect(hasRunStatusDeclaration("mentions SCAN STATUS: ok inline")).toBe(false);
    expect(hasRunStatusDeclaration("")).toBe(false);
  });
});

describe("describeUsageLimitReset", () => {
  test("returns the account's own words, whatever the phrasing", () => {
    expect(
      describeUsageLimitReset("You've hit your weekly limit · resets Aug 20, 9am (UTC)"),
    ).toBe("Aug 20, 9am (UTC)");
    expect(
      describeUsageLimitReset("You've hit your session limit · resets 12:50pm (UTC)"),
    ).toBe("12:50pm (UTC)");
    expect(describeUsageLimitReset("5-hour limit reached ∙ resets 3am")).toBe("3am");
  });

  test("no reset stated means no opinion", () => {
    expect(describeUsageLimitReset("You're out of usage credits.")).toBeUndefined();
    expect(describeUsageLimitReset("")).toBeUndefined();
  });
});

describe("usageLimitResetAt", () => {
  // A fixed "now" so these never drift: 2026-08-18T18:54:02Z, the minute the
  // weekly-limit failure this parser was written for actually happened.
  const now = Date.UTC(2026, 7, 18, 18, 54, 2);

  test("a dated weekly reset benches for days, not the one-hour default", () => {
    const at = usageLimitResetAt(
      "You've hit your weekly limit · resets Aug 20, 9am (UTC)",
      now,
    );
    expect(at).toBe(Date.UTC(2026, 7, 20, 9, 0));
    // The whole point: far beyond the hour markExhausted would have used.
    expect(at! - now).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  test("a bare time means the next occurrence of it", () => {
    // 3am has passed today ⇒ tomorrow.
    expect(usageLimitResetAt("5-hour limit reached ∙ resets 3am", now)).toBe(
      Date.UTC(2026, 7, 19, 3, 0),
    );
    // 11:30pm is still ahead today.
    expect(usageLimitResetAt("limit · resets 11:30pm (UTC)", now)).toBe(
      Date.UTC(2026, 7, 18, 23, 30),
    );
  });

  test("a date with no year picks the occurrence ahead of now", () => {
    const dec = Date.UTC(2026, 11, 30, 12, 0);
    expect(usageLimitResetAt("resets Jan 2, 9am (UTC)", dec)).toBe(
      Date.UTC(2027, 0, 2, 9, 0),
    );
  });

  test("refuses anything it cannot vouch for, so the caller keeps its default", () => {
    // No time of day.
    expect(usageLimitResetAt("resets soon", now)).toBeUndefined();
    // No reset at all.
    expect(usageLimitResetAt("You're out of usage credits.", now)).toBeUndefined();
    // Unknown month.
    expect(usageLimitResetAt("resets Foo 20, 9am (UTC)", now)).toBeUndefined();
    // Beyond the 14-day ceiling: a mis-parse must never bench a healthy
    // account for weeks, which would be worse than the churn this replaces.
    expect(usageLimitResetAt("resets Sep 30, 9am (UTC)", now)).toBeUndefined();
  });
});
