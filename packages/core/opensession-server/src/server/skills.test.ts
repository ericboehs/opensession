import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { searchSkills } from "./skills";

const home = process.env.HOME!;
const skillRoot = join(home, ".config", "opencode", "skills");
const target = join(home, ".opensession-skills-test-target");
const link = join(skillRoot, "opensession-symlink-test");

afterEach(() => {
  rmSync(link, { force: true });
  rmSync(target, { force: true, recursive: true });
});

describe("searchSkills", () => {
  test("discovers installer-managed global skill symlinks", () => {
    mkdirSync(target, { recursive: true });
    mkdirSync(skillRoot, { recursive: true });
    writeFileSync(
      join(target, "SKILL.md"),
      "---\nname: opensession-symlink-test\ndescription: Symlinked skill\n---\n",
    );
    symlinkSync(target, link, "dir");

    expect(searchSkills(undefined, "opensession-symlink-test")).toEqual([
      {
        name: "opensession-symlink-test",
        description: "Symlinked skill",
        source: "user",
      },
    ]);
  });
});
