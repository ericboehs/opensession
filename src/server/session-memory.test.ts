import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { MEMORY_DIR } from "../agents/slack/memory";
import {
  addSessionMemory,
  forgetSessionMemory,
  listSessionMemory,
  renderSessionMemoryNote,
  sessionMemoryScopes,
  type MemoryScope,
} from "./session-memory";

// Round-trip tests write to uniquely-named scope files inside the real store
// dir (never touching existing scopes) and remove them afterwards.
const TEST_REPO = `__sm-test-${Math.random().toString(36).slice(2, 8)}`;
const TEST_SCOPE: MemoryScope = {
  key: `repo-${TEST_REPO}`,
  kind: "repo",
  label: TEST_REPO,
};

afterAll(() => {
  rmSync(`${MEMORY_DIR}/${TEST_SCOPE.key}.json`, { force: true });
});

describe("sessionMemoryScopes", () => {
  test("repo scopes first (deduped), then user, then team", () => {
    const scopes = sessionMemoryScopes({
      user: "definitely-not-a-teammate-xyz",
      repos: ["tella-fusion", "backstage", "tella-fusion"],
    });
    expect(scopes.map((s) => s.key)).toEqual([
      "repo-tella-fusion",
      "repo-backstage",
      "user-definitely-not-a-teammate-xyz",
      "workspace",
    ]);
    expect(scopes.at(-1)?.kind).toBe("team");
  });

  test("teammate user unifies with their Slack DM store (user-<slackId>)", () => {
    const scopes = sessionMemoryScopes({ user: "michiel", repos: [] });
    const user = scopes.find((s) => s.kind === "user");
    expect(user?.key).toMatch(/^user-U[A-Z0-9]+$/);
  });

  test("no user → no user scope; includeTeam:false drops workspace", () => {
    expect(
      sessionMemoryScopes({ repos: ["a"], includeTeam: false }).map((s) => s.key)
    ).toEqual(["repo-a"]);
  });
});

describe("memory round-trip", () => {
  test("add → list → forget", async () => {
    const entry = await addSessionMemory(TEST_SCOPE, "  the fact  ", "tester");
    expect(entry.text).toBe("the fact");

    const listed = await listSessionMemory([TEST_SCOPE]);
    expect(listed[0].entries.map((e) => e.id)).toContain(entry.id);

    const note = await renderSessionMemoryNote([TEST_SCOPE]);
    expect(note).toContain(`[${entry.id}] the fact`);
    expect(note).toContain(`Repo ${TEST_REPO}:`);

    const gone = await forgetSessionMemory([TEST_SCOPE], entry.id);
    expect(gone.ok).toBe(true);
    expect((await listSessionMemory([TEST_SCOPE]))[0].entries).toHaveLength(0);
  });

  test("forget of unknown id fails cleanly", async () => {
    const res = await forgetSessionMemory([TEST_SCOPE], "nope1234");
    expect(res.ok).toBe(false);
  });
});

describe("renderSessionMemoryNote", () => {
  test("empty scopes render nothing without tools, guidance with tools", async () => {
    expect(await renderSessionMemoryNote([TEST_SCOPE])).toBe("");
    const withTools = await renderSessionMemoryNote([TEST_SCOPE], { tools: true });
    expect(withTools).toContain("store_memory");
  });
});
