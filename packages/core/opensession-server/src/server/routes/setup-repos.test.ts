import { $ } from "bun";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  adoptExistingCheckout,
  githubCredentialHelperCommand,
  matchesCodeStorageCheckout,
  validGithubFullName,
} from "./setup-repos";

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


describe("githubCredentialHelperCommand", () => {
  test("uses the stable installed command for compiled releases", () => {
    expect(
      githubCredentialHelperCommand("/home/alice/Open Session/bin/opensession", true),
    ).toBe("!'/home/alice/Open Session/bin/opensession' github-credential");
  });

  test("falls back to the source script before the shim is installed", () => {
    const command = githubCredentialHelperCommand("/missing/opensession", false);
    expect(command).toStartWith("!bun ");
    expect(command).toEndWith("scripts/gh-credential.ts");
  });

});

describe("adoptExistingCheckout", () => {
  const roots: string[] = [];
  const tmpRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "os-adopt-"));
    roots.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  });

  async function makeCheckout(dir: string, origin: string): Promise<string> {
    mkdirSync(dir, { recursive: true });
    await $`git -C ${dir} init -q -b main`.quiet();
    await $`git -C ${dir} remote add origin ${origin}`.quiet();
    await $`git -C ${dir} -c user.email=t@e -c user.name=t commit -q --allow-empty -m init`.quiet();
    return dir;
  }

  test("returns null when nothing is at the destination", async () => {
    expect(await adoptExistingCheckout(join(tmpRoot(), "absent"), () => true)).toBe(null);
  });

  test("adopts a checkout of the same repo (no token needed)", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://github.com/acme/widget.git",
    );
    const adopted = await adoptExistingCheckout(
      dest,
      (i) => (i.ghRepo || "").toLowerCase() === "acme/widget",
    );
    expect(adopted?.ghRepo).toBe("acme/widget");
    expect(adopted?.defaultBranch).toBe("main");
  });

  test("only adopts a code.storage checkout from the configured organization", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://old-org.code.storage/acme/widget.git",
    );
    const inspected = await adoptExistingCheckout(
      dest,
      (i) => matchesCodeStorageCheckout(i, "old-org", "acme/widget"),
    );
    expect(inspected?.cs).toEqual({ org: "old-org", repoId: "acme/widget" });
    expect(
      adoptExistingCheckout(
        dest,
        (i) => matchesCodeStorageCheckout(i, "new-org", "acme/widget"),
      ),
    ).rejects.toThrow(/Clone destination already exists/);
  });

  test("refuses a checkout of a different repo", async () => {
    const dest = await makeCheckout(
      join(tmpRoot(), "widget"),
      "https://github.com/acme/other.git",
    );
    expect(
      adoptExistingCheckout(dest, (i) => (i.ghRepo || "").toLowerCase() === "acme/widget"),
    ).rejects.toThrow(/Clone destination already exists/);
  });

  test("refuses a non-git directory at the destination", async () => {
    const dest = join(tmpRoot(), "widget");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "notes.txt"), "hi");
    expect(adoptExistingCheckout(dest, () => true)).rejects.toThrow(
      /Clone destination already exists/,
    );
  });
});
