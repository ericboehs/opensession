import { describe, expect, test } from "bun:test";
import { filterManifest, isNodeModulesEntry, seedableManifest } from "./warm-template";

// The manifest is `git ls-files -o -i --exclude-standard --directory` output
// from the template worktree: fully-ignored dirs collapsed with a trailing
// slash, individually-ignored files (ReScript's in-source *.res.mjs) listed
// one per line. filterManifest strips the runtime junk that must never be
// seeded into a fresh worktree.

describe("filterManifest", () => {
  test("keeps build artifacts, drops runtime junk", () => {
    const raw = [
      "node_modules/",
      "packages/core/webapp/node_modules/",
      "packages/core/webapp/.next/",
      "packages/core/webapp/lib/",
      "packages/core/webapp/src/frontend/App.res.mjs",
      "packages/core/webapp/src/bindings/wasm-bindings/tella_wasm_bindings.js",
      ".ports.conf",
      ".ports/",
      ".tunnels.env",
      "dev-server.log",
      "packages/core/webapp/.env.local",
      "packages/core/webapp/.env.development",
      ".direnv/",
      ".DS_Store",
      "packages/.DS_Store",
      "",
      "   ",
    ];
    expect(filterManifest(raw)).toEqual([
      "node_modules/",
      "packages/core/webapp/node_modules/",
      "packages/core/webapp/.next/",
      "packages/core/webapp/lib/",
      "packages/core/webapp/src/frontend/App.res.mjs",
      "packages/core/webapp/src/bindings/wasm-bindings/tella_wasm_bindings.js",
    ]);
  });

  test("keeps files that merely contain 'log' or 'env' in their name", () => {
    expect(
      filterManifest(["packages/logger/dist/", "src/environment.res.mjs", "catalog.res.mjs"]),
    ).toEqual(["packages/logger/dist/", "src/environment.res.mjs", "catalog.res.mjs"]);
  });
});

describe("seedableManifest", () => {
  test("keeps only node_modules trees — warm-preview-era manifests seed identically", () => {
    // A manifest captured before 2026-07-21 also lists .next/ReScript/WASM
    // artifacts; the same filter runs at capture AND seed time, so those
    // entries are ignored wherever they come from.
    const legacy = [
      "node_modules/",
      "packages/core/webapp/node_modules/",
      "packages/core/webapp/.next/",
      "packages/core/webapp/lib/",
      "packages/core/webapp/src/frontend/App.res.mjs",
      ".ports.conf",
      "dev-server.log",
    ];
    expect(seedableManifest(legacy)).toEqual([
      "node_modules/",
      "packages/core/webapp/node_modules/",
    ]);
  });
});

describe("isNodeModulesEntry", () => {
  test("matches node_modules dirs at any depth (hardlink-safe)", () => {
    expect(isNodeModulesEntry("node_modules/")).toBe(true);
    expect(isNodeModulesEntry("packages/core/webapp/node_modules/")).toBe(true);
  });

  test("everything else is a real copy (compilers rewrite in place)", () => {
    expect(isNodeModulesEntry("packages/core/webapp/.next/")).toBe(false);
    expect(isNodeModulesEntry("packages/core/webapp/lib/")).toBe(false);
    expect(isNodeModulesEntry("src/App.res.mjs")).toBe(false);
    // A file INSIDE node_modules would come from a partial listing — the
    // manifest only carries the collapsed dir, so anything else copies.
    expect(isNodeModulesEntry("node_modules/react/package.json")).toBe(false);
  });
});
