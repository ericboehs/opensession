/**
 * Regression pins for the OpenCode engine's on-disk state paths after the
 * Backstage → OpenSession rename (docs/rename-opensession-plan.md).
 *
 * The invariant under test: every state path the engine touches derives from
 * the SAME rename-compat dual-read resolution — never a hardcoded
 * `~/.backstage-*` or `~/.opensession-*` literal. When one module hardcodes a
 * name while another resolves, the two disagree exactly when it hurts: the
 * docker adapter mounts `<chats>/sandbox-runs/<id>` by the resolved name, and
 * an in-container runner resolving differently (or the image only pre-seeding
 * the other name, leaving docker to create the mount parent ROOT-owned)
 * EACCESes on `mkdir <chats>/opencode` (live failure bks-019f4742-e65c,
 * 2026-07-09, right after the state migration renamed ~/.backstage-* to
 * ~/.opensession-*).
 *
 * These assert cross-module CONSISTENCY at whatever resolution the current
 * host has (pre-migration hosts resolve old names, migrated hosts new ones) —
 * both worlds must agree module-to-module.
 */

import { describe, expect, it } from "bun:test";
import { OPENSESSION_CHATS_DIR } from "./paths";
import { envAlias, stateDir } from "./rename-compat";
import {
  MERIDIAN_CFG_ROOT,
  OPENCODE_STATE_DIR,
} from "./opencode-runner";
import { configPath } from "./opencode-config";
import { BRIDGE_CWD } from "./anthropic-bridge";
import { OPENAI_DATA_ROOT } from "./opencode-openai-auth";
import {
  OPENCODE_DB_PATH,
  OPENCODE_TRANSCRIPTS_DIR,
} from "./opencode-transcript";
import { containerStateDirFixups } from "./sandbox/docker";

const HOME = process.env.HOME || "/home/ubuntu";

describe("opencode engine state paths (rename-compat consistency)", () => {
  it("instructions/state dir lives under the resolved chat store", () => {
    expect(OPENCODE_STATE_DIR).toBe(`${OPENSESSION_CHATS_DIR}/opencode`);
  });

  it("meridian cfg, bridge cwd and openai data share one resolved engine dir", () => {
    const engineDir = stateDir("opencode");
    expect(MERIDIAN_CFG_ROOT).toBe(`${engineDir}/meridian-cfg`);
    expect(BRIDGE_CWD).toBe(`${engineDir}/bridge-cwd`);
    expect(OPENAI_DATA_ROOT).toBe(`${engineDir}/openai-data`);
  });

  it("bridge config file resolves through the compat seam", () => {
    expect(configPath()).toBe(
      envAlias("OPENSESSION_OPENCODE_CONFIG", "BACKSTAGE_OPENCODE_CONFIG") ||
        stateDir("opencode.json"),
    );
  });

  it("transcript mirror + sqlite store stay on their pinned (un-renamed) homes", () => {
    expect(OPENCODE_TRANSCRIPTS_DIR).toBe(
      envAlias(
        "OPENSESSION_OPENCODE_TRANSCRIPTS_DIR",
        "BACKSTAGE_OPENCODE_TRANSCRIPTS_DIR",
      ) || `${HOME}/.claude/projects/-opencode-engine`,
    );
    expect(OPENCODE_DB_PATH).toBe(
      envAlias("OPENSESSION_OPENCODE_DB", "BACKSTAGE_OPENCODE_DB") ||
        `${HOME}/.local/share/opencode/opencode.db`,
    );
  });

  it("docker re-owns exactly the chats-dir mount parents the runner writes under", () => {
    // The EACCES regression: these dirs are docker-created (root) when the
    // image predates the rename — setupContainer must chown them, and they
    // must be the SAME dirs the engine derives its state paths from.
    expect(containerStateDirFixups()).toEqual([
      OPENSESSION_CHATS_DIR,
      `${OPENSESSION_CHATS_DIR}/sandbox-runs`,
    ]);
    expect(OPENCODE_STATE_DIR.startsWith(`${OPENSESSION_CHATS_DIR}/`)).toBe(true);
  });
});
