import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  getConfig,
  configuredRepos,
  configuredPaths,
  configuredServer,
  configuredIdentity,
  defaultRepo,
  personaName,
  productName,
  productMark,
} from "./config";

// Each case writes its config to a fresh path (the loader caches by
// path+mtime) and points BACKSTAGE_CONFIG at it.
const ENV_KEYS = [
  "BACKSTAGE_CONFIG",
  "BACKSTAGE_TELLA_FUSION",
  "BACKSTAGE_WORKTREES_DIR",
  "BACKSTAGE_CLAUDE_BIN",
  "BACKSTAGE_OPENCODE_BIN",
  "BACKSTAGE_MCP_CONFIG",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];

const dirs: string[] = [];
function withConfig(contents: string | null): void {
  const dir = mkdtempSync(join(tmpdir(), "bks-config-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  if (contents !== null) writeFileSync(path, contents);
  process.env.BACKSTAGE_CONFIG = path;
}

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("config loader", () => {
  test("no file → built-in Tella defaults", () => {
    withConfig(null); // path exists as a dir entry that was never written
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];

    expect(getConfig()).toEqual({});

    const repos = configuredRepos();
    expect(Object.keys(repos).sort()).toEqual([
      "backstage",
      "gitops",
      "gst-plugins-rs",
      "gstreamer",
      "infra",
      "shared-infra",
      "tella-fusion",
    ]);
    expect(repos["tella-fusion"]).toMatchObject({
      id: "tella-fusion",
      repo: "/home/ubuntu/projects/tella-fusion",
      wtPrefix: "tella-fusion",
      defaultBranch: "main",
      ghRepo: "tellahq/tella-fusion",
    });
    expect(repos["backstage"]).toMatchObject({
      repo: "/home/ubuntu/projects/tella-backstage",
      defaultBranch: "master",
      ghRepo: "tellahq/backstage",
      sharedCheckout: true,
    });
    expect(defaultRepo().id).toBe("tella-fusion");

    const paths = configuredPaths();
    expect(paths.claudeBin).toBe("/home/ubuntu/.local/bin/claude");
    expect(paths.worktreesDir).toBe("/home/ubuntu/worktrees");
    expect(paths.wtScript).toBe("/home/ubuntu/bin/wt");

    const identity = configuredIdentity();
    expect(identity.team.length).toBe(8);
    expect(identity.slackNames["U0A7T08405R"]).toBe("Michael");

    expect(configuredServer().caddyAdmin).toBe("http://localhost:2019");
  });

  test("partial file → merges over defaults", () => {
    withConfig(
      JSON.stringify({
        paths: { worktreesDir: "/srv/worktrees" },
        repos: {
          "tella-fusion": { ghRepo: "acme/fusion-fork", depsInstall: "bun install" },
          "acme-app": { repo: "/srv/acme-app", default: true },
        },
      }),
    );
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];

    const repos = configuredRepos();
    // Overridden fields apply; untouched fields keep their built-in values.
    expect(repos["tella-fusion"].ghRepo).toBe("acme/fusion-fork");
    expect(repos["tella-fusion"].depsInstall).toBe("bun install");
    expect(repos["tella-fusion"].repo).toBe("/home/ubuntu/projects/tella-fusion");
    expect(repos["tella-fusion"].defaultBranch).toBe("main");
    // New repo gets id-derived defaults.
    expect(repos["acme-app"]).toEqual({
      id: "acme-app",
      repo: "/srv/acme-app",
      wtPrefix: "acme-app",
      defaultBranch: "main",
      ghRepo: "",
      default: true,
    });
    // Built-ins survive untouched.
    expect(repos["gitops"].ghRepo).toBe("tellahq/gitops");
    // The default flag wins over the tella-fusion fallback.
    expect(defaultRepo().id).toBe("acme-app");
    // Config path beats the built-in default.
    expect(configuredPaths().worktreesDir).toBe("/srv/worktrees");
  });

  test("repo entry without a checkout path is ignored", () => {
    withConfig(JSON.stringify({ repos: { phantom: { ghRepo: "acme/phantom" } } }));
    expect(configuredRepos()["phantom"]).toBeUndefined();
  });

  test("malformed file → defaults", () => {
    withConfig("{ this is not json");
    for (const k of ENV_KEYS.slice(1)) delete process.env[k];
    expect(getConfig()).toEqual({});
    expect(configuredRepos()["tella-fusion"].repo).toBe("/home/ubuntu/projects/tella-fusion");
    expect(defaultRepo().id).toBe("tella-fusion");
    expect(configuredIdentity().team.length).toBe(8);
  });

  test("non-object JSON → defaults", () => {
    withConfig(JSON.stringify(["not", "an", "object"]));
    expect(getConfig()).toEqual({});
  });

  test("env vars beat config.json per key", () => {
    withConfig(
      JSON.stringify({
        paths: { worktreesDir: "/from-config/worktrees", claudeBin: "/from-config/claude" },
        repos: { "tella-fusion": { repo: "/from-config/tella-fusion" } },
      }),
    );
    process.env.BACKSTAGE_WORKTREES_DIR = "/from-env/worktrees";
    process.env.BACKSTAGE_CLAUDE_BIN = "/from-env/claude";
    process.env.BACKSTAGE_TELLA_FUSION = "/from-env/tella-fusion";

    expect(configuredPaths().worktreesDir).toBe("/from-env/worktrees");
    expect(configuredPaths().claudeBin).toBe("/from-env/claude");
    expect(configuredRepos()["tella-fusion"].repo).toBe("/from-env/tella-fusion");

    // …and the config value applies once the env var is gone.
    delete process.env.BACKSTAGE_WORKTREES_DIR;
    delete process.env.BACKSTAGE_TELLA_FUSION;
    expect(configuredPaths().worktreesDir).toBe("/from-config/worktrees");
    expect(configuredRepos()["tella-fusion"].repo).toBe("/from-config/tella-fusion");
  });

  test("identity: section present with empty team → empty tables, no throws", () => {
    withConfig(JSON.stringify({ identity: { team: [] } }));
    const identity = configuredIdentity();
    expect(identity.team).toEqual([]);
    expect(identity.slackNames).toEqual({});
  });

  test("persona/branding: defaults with no config file", () => {
    withConfig(null);
    expect(personaName()).toBe("Michael");
    expect(productName()).toBe("OpenSession");
    expect(productMark()).toBe("OpenSession");
  });

  test("persona/branding: config overrides apply", () => {
    withConfig(
      JSON.stringify({
        persona: { name: "Ava" },
        branding: { productName: "OpenSession", productMark: "OS" },
      }),
    );
    expect(personaName()).toBe("Ava");
    expect(productName()).toBe("OpenSession");
    expect(productMark()).toBe("OS");
  });

  test("branding: productMark falls back to productName", () => {
    withConfig(JSON.stringify({ branding: { productName: "OpenSession" } }));
    expect(productMark()).toBe("OpenSession");
    // Empty/whitespace strings are treated as unset, not honored.
    withConfig(JSON.stringify({ persona: { name: "  " }, branding: { productName: "" } }));
    expect(personaName()).toBe("Michael");
    expect(productName()).toBe("OpenSession");
  });

  test("identity: custom roster is parsed and validated", () => {
    withConfig(
      JSON.stringify({
        identity: {
          team: [
            { name: "Ada Lovelace", email: "ada@acme.dev", github: "ada", slackId: "U111", aliases: ["ada"] },
            { notAName: true }, // invalid — dropped
          ],
          slackNames: { U222: "Bot", U333: 42 }, // non-string values dropped
        },
      }),
    );
    const identity = configuredIdentity();
    expect(identity.team).toEqual([
      { name: "Ada Lovelace", email: "ada@acme.dev", github: "ada", slackId: "U111", aliases: ["ada"] },
    ]);
    expect(identity.slackNames).toEqual({ U222: "Bot" });
  });
});
