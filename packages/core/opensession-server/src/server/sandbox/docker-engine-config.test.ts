/**
 * The engine-config projection seam for docker sandboxes: engineConfigMounts
 * must land the opencode bridge config AND the pi engine config at the exact
 * legacy in-container paths the guest runner-host reads (path parity is the
 * sandbox contract; the remote adapters' upload destinations are the same
 * names), and a missing host file must be omitted rather than mounted (a
 * docker bind of a missing path creates a directory in its place).
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { engineConfigMounts } from "./docker";
import {
  REMOTE_HOME,
  REMOTE_OPENCODE_CONFIG,
  REMOTE_PI_CONFIG,
} from "./adapters/bootstrap";

const scratch = mkdtempSync(join(tmpdir(), "engine-config-mounts-"));
const ocPath = join(scratch, "opencode.json");
const piPath = join(scratch, "pi.json");
writeFileSync(ocPath, "{}\n");
writeFileSync(piPath, JSON.stringify({ enabled: true }) + "\n");

const savedOc = process.env.OPENSESSION_OPENCODE_CONFIG;
const savedPi = process.env.OPENSESSION_PI_CONFIG;

afterEach(() => {
  if (savedOc === undefined) delete process.env.OPENSESSION_OPENCODE_CONFIG;
  else process.env.OPENSESSION_OPENCODE_CONFIG = savedOc;
  if (savedPi === undefined) delete process.env.OPENSESSION_PI_CONFIG;
  else process.env.OPENSESSION_PI_CONFIG = savedPi;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("engineConfigMounts", () => {
  test("projects both configs at the legacy in-container names", () => {
    process.env.OPENSESSION_OPENCODE_CONFIG = ocPath;
    process.env.OPENSESSION_PI_CONFIG = piPath;
    expect(engineConfigMounts("/home/ubuntu")).toEqual([
      [ocPath, "/home/ubuntu/.opensession-opencode.json"],
      [piPath, "/home/ubuntu/.opensession-pi.json"],
    ]);
  });

  test("destinations match the remote adapters' upload paths (one contract)", () => {
    process.env.OPENSESSION_OPENCODE_CONFIG = ocPath;
    process.env.OPENSESSION_PI_CONFIG = piPath;
    const dests = engineConfigMounts(REMOTE_HOME).map(([, dest]) => dest);
    expect(dests).toEqual([REMOTE_OPENCODE_CONFIG, REMOTE_PI_CONFIG]);
  });

  test("omits a missing source instead of mounting it", () => {
    process.env.OPENSESSION_OPENCODE_CONFIG = ocPath;
    process.env.OPENSESSION_PI_CONFIG = join(scratch, "missing-pi.json");
    expect(engineConfigMounts("/home/ubuntu")).toEqual([
      [ocPath, "/home/ubuntu/.opensession-opencode.json"],
    ]);
  });
});
