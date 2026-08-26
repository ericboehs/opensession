import { describe, expect, test } from "bun:test";
import { githubGitCredentialEnv } from "./github-git-credential";

describe("GitHub Git credential environment", () => {
  test("rewrites SSH remotes to process-local HTTPS authority", () => {
    const env = githubGitCredentialEnv("projected-token", "!credential-helper");
    expect(env).toMatchObject({
      GH_TOKEN: "projected-token",
      GITHUB_TOKEN: "projected-token",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "4",
      GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_2: "git@github.com:",
      GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
      GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
    });
  });

  test("keeps the HTTPS rewrite when authority is unavailable", () => {
    const env = githubGitCredentialEnv("", "!credential-helper");
    expect(env.GH_TOKEN).toBe("");
    expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});
