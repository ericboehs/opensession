/**
 * Where an Open Session install lives on disk.
 *
 * Layout, modelled on self-hosted tools's single dot-directory:
 *
 *   ~/.opensession/
 *     bin/opensession     shim on PATH, execs the CLI in this checkout
 *     src/                the git checkout (unless installed elsewhere)
 *     config.json         instance config
 *   ~/.opensession.env    secrets (systemd EnvironmentFile)
 *
 * REPO_ROOT is derived from this file's location rather than assumed, so the
 * CLI works identically from ~/.opensession/src, from a developer's clone, and
 * from a worktree.
 */

import { homedir } from "os";
import { join, resolve } from "path";

export const HOME = homedir();

/** Root of the checkout this CLI is running from. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..");

/** Everything a normal install owns, overridable for tests and side-by-side installs. */
export const OPENSESSION_HOME = process.env.OPENSESSION_HOME || join(HOME, ".opensession");

export const BIN_DIR = join(OPENSESSION_HOME, "bin");
export const SHIM_PATH = join(BIN_DIR, "opensession");
export const CONFIG_PATH = process.env.OPENSESSION_CONFIG || join(OPENSESSION_HOME, "config.json");
export const ENV_PATH = process.env.OPENSESSION_ENV_FILE || join(HOME, ".opensession.env");

/** The unit name is fixed; the file is rendered per-box at onboard time. */
export const SERVICE_NAME = "opensession";
export const SERVICE_PATH = `/etc/systemd/system/${SERVICE_NAME}.service`;
export const STAGED_UNIT_PATH = join(OPENSESSION_HOME, "opensession.service");
export const EXECUTOR_SERVICE_NAME = "opensession-executor";
export const EXECUTOR_SERVICE_PATH = `/etc/systemd/system/${EXECUTOR_SERVICE_NAME}.service`;
export const STAGED_EXECUTOR_UNIT_PATH = join(
  OPENSESSION_HOME,
  "opensession-executor.service",
);
export const EXECUTOR_TOKEN_PATH = "/etc/opensession/executor-token";
