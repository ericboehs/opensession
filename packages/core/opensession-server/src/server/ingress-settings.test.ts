import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  normalizeCustomIngressOrigin,
  normalizeIngressOrigin,
  publicIngressHealth,
  savePublicIngress,
} from "./ingress-settings";

const previous = process.env.OPENSESSION_CONFIG;
const dirs: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "opensession-ingress-settings-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    server: {
      publicBaseUrl: "https://app.example.test",
      webhookBaseUrl: "https://old.example.test",
      webhookPort: 3848,
    },
  }));
  process.env.OPENSESSION_CONFIG = path;
  delete process.env.OPENSESSION_INGRESS_BASE;
  return path;
}

afterEach(() => {
  if (previous === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = previous;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("public ingress settings", () => {
  test("requires a separate public HTTPS origin", () => {
    fixture();
    expect(normalizeIngressOrigin("https://ingress.example.test/")).toBe("https://ingress.example.test");
    expect(() => normalizeIngressOrigin("http://ingress.example.test")).toThrow("must use HTTPS");
    expect(() => normalizeIngressOrigin("https://app.example.test")).toThrow("different hostname");
    expect(() => normalizeIngressOrigin("https://127.0.0.1")).toThrow("public internet");
  });

  test("custom domains do not require URL syntax", () => {
    fixture();
    expect(normalizeCustomIngressOrigin("ingress.example.test")).toBe("https://ingress.example.test");
    expect(normalizeCustomIngressOrigin("https://ingress.example.test/")).toBe("https://ingress.example.test");
    expect(() => normalizeCustomIngressOrigin("http://ingress.example.test")).toThrow("must use HTTPS");
  });

  test("reports DNS propagation separately from a broken listener", () => {
    const server = { a: ["203.0.113.10"], aaaa: [] };
    expect(publicIngressHealth("custom", "unreachable", { a: [], aaaa: [] }, server)).toBe("waiting_dns");
    expect(publicIngressHealth("custom", "unreachable", { a: ["203.0.113.20"], aaaa: [] }, server)).toBe("waiting_dns");
    expect(publicIngressHealth("custom", "unreachable", { a: ["203.0.113.10"], aaaa: [] }, server)).toBe("unreachable");
    expect(publicIngressHealth("cloudflare", "unreachable", { a: [], aaaa: [] }, server)).toBe("unreachable");
  });

  test("writes one canonical owner and removes retired server fields", async () => {
    const path = fixture();
    await savePublicIngress({
      publicBaseUrl: "https://ingress.example.test",
      exposure: "cloudflare",
      cloudflareTunnelId: "11111111-2222-3333-4444-555555555555",
    });
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.ingress).toEqual({
      publicBaseUrl: "https://ingress.example.test",
      exposure: "cloudflare",
      cloudflareTunnelId: "11111111-2222-3333-4444-555555555555",
    });
    expect(saved.server).toEqual({ publicBaseUrl: "https://app.example.test" });
  });
});
