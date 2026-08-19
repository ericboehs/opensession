import { describe, expect, test } from "bun:test";
import { validGithubFullName } from "./setup-repos";

describe("validGithubFullName", () => {
  test("accepts ordinary owner/name pairs", () => {
    expect(validGithubFullName("tellahq/tella-fusion")).toBe(true);
    expect(validGithubFullName("owner/repo.name")).toBe(true);
    expect(validGithubFullName("o-w_n.er/re-po_1")).toBe(true);
  });

  test("rejects non-strings and empty parts", () => {
    expect(validGithubFullName(undefined)).toBe(false);
    expect(validGithubFullName(null)).toBe(false);
    expect(validGithubFullName(42)).toBe(false);
    expect(validGithubFullName("")).toBe(false);
    expect(validGithubFullName("owner/")).toBe(false);
    expect(validGithubFullName("/repo")).toBe(false);
    expect(validGithubFullName("just-a-name")).toBe(false);
  });

  test("rejects extra path segments and traversal", () => {
    expect(validGithubFullName("a/b/c")).toBe(false);
    expect(validGithubFullName("../etc/passwd")).toBe(false);
    expect(validGithubFullName("owner/..%2Fescape")).toBe(false);
  });

  test("rejects shell- and URL-meaningful characters", () => {
    expect(validGithubFullName("owner/repo;rm -rf /")).toBe(false);
    expect(validGithubFullName("owner/repo$(id)")).toBe(false);
    expect(validGithubFullName("owner/repo name")).toBe(false);
    expect(validGithubFullName("owner/repo\n")).toBe(false);
    expect(validGithubFullName("https://github.com/owner/repo")).toBe(false);
    expect(validGithubFullName("owner/repo?x=1")).toBe(false);
    expect(validGithubFullName("owner/repo#frag")).toBe(false);
    // Matches the regex, but is harmless: the clone always receives the full
    // https URL via array spawn, so a "-"-prefixed owner can't become a flag.
    expect(validGithubFullName("--flag/repo")).toBe(true);
  });
});
