import { describe, expect, test } from "bun:test";
import { githubRepositoryMatchesInstallation } from "./github-app";

describe("repository-scoped App installation identity", () => {
  test("requires the requested repository owner to match the selected installation", () => {
    expect(githubRepositoryMatchesInstallation("tellahq/opensession", "TellaHQ")).toBe(true);
    expect(githubRepositoryMatchesInstallation("acme/opensession", "tellahq")).toBe(false);
    expect(githubRepositoryMatchesInstallation("tellahq/opensession/extra", "tellahq")).toBe(false);
    expect(githubRepositoryMatchesInstallation("tellahq/opensession", undefined)).toBe(false);
  });
});
