/**
 * Unit tests for the sandbox provider-status surface (GET /api/sandbox/status
 * serves sandboxCapabilityStatus() verbatim — the route itself is a one-liner,
 * so this IS the endpoint's behavior) and for resolveRequestedSandbox, the
 * create-path validator behind the per-session provider picker.
 *
 * Config is pointed at a scratch file via BACKSTAGE_SANDBOX_CONFIG (read fresh
 * per call), saved/restored so the rest of the suite never sees it. The
 * kill-switch file lives under BACKSTAGE_CHATS_DIR; expectations read the live
 * sandboxesEnabled() instead of assuming it, so a dev box with the switch on
 * still passes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveRequestedSandbox,
  sandboxCapabilityStatus,
  sandboxProviderConfigured,
  sandboxesEnabled,
} from "./config";

let scratch: string;
let prevEnvConfig: string | undefined;
let prevDaytonaKey: string | undefined;
let prevE2bKey: string | undefined;
const cfgPath = () => join(scratch, "sandbox.json");

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "bks-sandbox-status-"));
  prevEnvConfig = process.env.BACKSTAGE_SANDBOX_CONFIG;
  prevDaytonaKey = process.env.DAYTONA_API_KEY;
  prevE2bKey = process.env.E2B_API_KEY;
  process.env.BACKSTAGE_SANDBOX_CONFIG = cfgPath();
  delete process.env.DAYTONA_API_KEY;
  delete process.env.E2B_API_KEY;
});

afterEach(() => {
  try {
    unlinkSync(cfgPath());
  } catch {}
});

afterAll(() => {
  if (prevEnvConfig === undefined) delete process.env.BACKSTAGE_SANDBOX_CONFIG;
  else process.env.BACKSTAGE_SANDBOX_CONFIG = prevEnvConfig;
  if (prevDaytonaKey !== undefined) process.env.DAYTONA_API_KEY = prevDaytonaKey;
  if (prevE2bKey !== undefined) process.env.E2B_API_KEY = prevE2bKey;
  rmSync(scratch, { recursive: true, force: true });
});

const write = (cfg: object) => writeFileSync(cfgPath(), JSON.stringify(cfg));

describe("sandboxCapabilityStatus (the /api/sandbox/status payload)", () => {
  test("no config file: disabled, everything unconfigured, default local", () => {
    const s = sandboxCapabilityStatus();
    expect(s.enabled).toBe(false);
    expect(s.defaultProvider).toBe("local");
    expect(s.providers.map((p) => p.id)).toEqual(["docker", "daytona", "e2b"]);
    expect(s.providers.every((p) => !p.configured)).toBe(true);
    expect(s.killSwitch).toBe(!sandboxesEnabled());
  });

  test("docker-only config: docker configured, remotes not", () => {
    write({ provider: "docker", image: "backstage-runner:latest" });
    const s = sandboxCapabilityStatus();
    expect(s.enabled).toBe(true);
    expect(s.defaultProvider).toBe("docker");
    expect(s.providers.find((p) => p.id === "docker")?.configured).toBe(true);
    expect(s.providers.find((p) => p.id === "daytona")?.configured).toBe(false);
    expect(s.providers.find((p) => p.id === "daytona")?.note).toBeUndefined();
    expect(s.providers.find((p) => p.id === "e2b")?.configured).toBe(false);
  });

  test("daytona apiKey configures daytona and carries the dial-back caveat", () => {
    write({ provider: "docker", daytona: { apiKey: "dtn_x" } });
    const s = sandboxCapabilityStatus();
    const d = s.providers.find((p) => p.id === "daytona")!;
    expect(d.configured).toBe(true);
    expect(d.note).toContain("dial-back unverified");
  });

  test("e2b apiKey configures e2b, no note", () => {
    write({ provider: "docker", e2b: { apiKey: "e2b_x" } });
    const e = sandboxCapabilityStatus().providers.find((p) => p.id === "e2b")!;
    expect(e.configured).toBe(true);
    expect(e.note).toBeUndefined();
  });

  test("garbage config = no config", () => {
    writeFileSync(cfgPath(), "{nope");
    expect(sandboxCapabilityStatus().enabled).toBe(false);
    expect(sandboxProviderConfigured("docker")).toBe(false);
  });
});

describe("resolveRequestedSandbox (create-path validation)", () => {
  test("falsy = no sandbox", () => {
    expect(resolveRequestedSandbox(undefined)).toEqual({ ok: true, provider: null });
    expect(resolveRequestedSandbox(false)).toEqual({ ok: true, provider: null });
    expect(resolveRequestedSandbox("")).toEqual({ ok: true, provider: null });
  });

  test("true = config default provider (today's boolean behavior)", () => {
    write({ provider: "docker" });
    const r = resolveRequestedSandbox(true);
    expect(r.ok).toBe(true);
    // Kill-switch-aware like effectiveSandboxProvider — on a switched-off box
    // this resolves to local, matching the boolean path's existing semantics.
    if (r.ok) expect(r.provider).toBe(sandboxesEnabled() ? "docker" : "local");
  });

  test("explicit configured provider is accepted", () => {
    write({ provider: "docker", daytona: { apiKey: "dtn_x" } });
    expect(resolveRequestedSandbox("docker")).toEqual({ ok: true, provider: "docker" });
    expect(resolveRequestedSandbox("daytona")).toEqual({ ok: true, provider: "daytona" });
    expect(resolveRequestedSandbox("DOCKER")).toEqual({ ok: true, provider: "docker" });
  });

  test("explicit unconfigured provider fails with a pointed error", () => {
    write({ provider: "docker" }); // no daytona/e2b keys
    const r = resolveRequestedSandbox("daytona");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("daytona");
    const e = resolveRequestedSandbox("e2b");
    expect(e.ok).toBe(false);
    if (!e.ok) expect(e.error).toContain("e2b");
  });

  test("docker without any config file fails", () => {
    const r = resolveRequestedSandbox("docker");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not configured");
  });

  test("unknown provider string fails; 'local' means host", () => {
    write({ provider: "docker" });
    const r = resolveRequestedSandbox("modal");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("Unknown sandbox provider");
    expect(resolveRequestedSandbox("local")).toEqual({ ok: true, provider: null });
  });
});
