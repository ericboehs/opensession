import { describe, expect, test, beforeAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Point the module at a temp store BEFORE it loads (env is read at import).
const dir = mkdtempSync(join(tmpdir(), "claude-accounts-test-"));
const storePath = join(dir, "accounts.json");
process.env.BACKSTAGE_CLAUDE_ACCOUNTS_PATH = storePath;

const mkAccount = (id: string, owner?: string) => ({
  id,
  name: id,
  token: `sk-ant-oat01-${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...(owner ? { owner } : {}),
});

writeFileSync(
  storePath,
  JSON.stringify({
    accounts: [mkAccount("fresh"), mkAccount("maxed"), mkAccount("personal", "Michiel")],
  })
);

const usage = (
  fiveHourPct: number,
  extra?: { enabled: boolean; usedCredits: number; monthlyLimit: number }
) => ({
  fetchedAt: new Date().toISOString(),
  fiveHour: { utilization: fiveHourPct, resetsAt: null },
  sevenDay: null,
  extraUsage: extra ?? null,
});

let accounts: typeof import("./claude-accounts");

beforeAll(async () => {
  accounts = await import("./claude-accounts");
});

describe("pickAccount usage-credits policy", () => {
  test("skips a maxed account by default, even with credit headroom", () => {
    accounts.__setUsageCacheForTest("fresh", usage(50));
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 0, monthlyLimit: 100_000 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]))?.id).toBeUndefined();
  });

  test("allowExtraUsage picks a maxed account with credit headroom", () => {
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)?.id).toBe("maxed");
  });

  test("prefers subscription capacity over credits when both are available", () => {
    expect(accounts.pickAccount(undefined, undefined, undefined, true)?.id).toBe("fresh");
  });

  test("no headroom when extra usage is off or the monthly cap is spent", () => {
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: false, usedCredits: 0, monthlyLimit: 100_000 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)).toBeUndefined();

    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 100_001, monthlyLimit: 100_000 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)).toBeUndefined();

    // A zero monthly cap fails closed — this gate exists to bound spend.
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 0, monthlyLimit: 0 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)).toBeUndefined();
  });

  test("getUsableAccountById honors allowExtraUsage the same way", () => {
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: true, usedCredits: 50_000, monthlyLimit: 100_000 })
    );
    expect(accounts.getUsableAccountById("maxed")).toBeUndefined();
    expect(accounts.getUsableAccountById("maxed", undefined, true)?.id).toBe("maxed");
  });

  test("getAccountById returns records regardless of usability", () => {
    expect(accounts.getAccountById("maxed")?.id).toBe("maxed");
    expect(accounts.getAccountById("nope")).toBeUndefined();
  });

  test("personal accounts stay off-limits to userless (automation) picks", () => {
    accounts.__setUsageCacheForTest("personal", usage(0));
    accounts.__setUsageCacheForTest(
      "maxed",
      usage(100, { enabled: false, usedCredits: 0, monthlyLimit: 0 })
    );
    expect(accounts.pickAccount(new Set(["fresh"]), undefined, undefined, true)).toBeUndefined();
  });
});
