import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { RouteContext } from "./context";
import { handleSetupAccessRoutes } from "./setup-access";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedEnvFile = process.env.OPENSESSION_ENV_FILE;
const dirs: string[] = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "opensession-setup-access-"));
  dirs.push(dir);
  const config = join(dir, "config.json");
  const env = join(dir, "opensession.env");
  writeFileSync(
    config,
    JSON.stringify({
      server: { publicBaseUrl: "http://100.72.1.4:3850" },
      identity: {
        team: [{ name: "Admin", github: "admin", admin: true }],
      },
    }),
  );
  writeFileSync(env, "OPENSESSION_UI_BASE=http://100.72.1.4:3850\n");
  process.env.OPENSESSION_CONFIG = config;
  process.env.OPENSESSION_ENV_FILE = env;
  return { config, env };
}

function context(body: unknown): RouteContext {
  const url = new URL("http://localhost/api/setup/access");
  return {
    req: new Request(url, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
    path: url.pathname,
    publicPrefix: "",
    authUser: { login: "admin", name: "Admin" },
  };
}

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  if (savedEnvFile === undefined) delete process.env.OPENSESSION_ENV_FILE;
  else process.env.OPENSESSION_ENV_FILE = savedEnvFile;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("setup access route", () => {
  test("stores separate app and webhook origins in config and the service env", async () => {
    const paths = fixture();
    const response = await handleSetupAccessRoutes(
      context({
        publicBaseUrl: "https://OS.Example.com/",
        webhookBaseUrl: "https://Hooks.Example.com/",
      }),
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      access: {
        publicBaseUrl: "https://os.example.com",
        webhookBaseUrl: "https://hooks.example.com",
      },
      restartRequired: true,
    });
    expect(JSON.parse(readFileSync(paths.config, "utf-8")).server).toMatchObject({
      publicBaseUrl: "https://os.example.com",
      webhookBaseUrl: "https://hooks.example.com",
    });
    const env = readFileSync(paths.env, "utf-8");
    expect(env).toContain("OPENSESSION_UI_BASE=https://os.example.com");
    expect(env).toContain("OPENSESSION_WEBHOOK_BASE=https://hooks.example.com");
  });

  test("clears the separate webhook origin from both stores", async () => {
    const paths = fixture();
    await handleSetupAccessRoutes(
      context({
        publicBaseUrl: "https://os.example.com",
        webhookBaseUrl: "https://hooks.example.com",
      }),
    );
    const response = await handleSetupAccessRoutes(
      context({
        publicBaseUrl: "https://os.example.com",
        webhookBaseUrl: "",
      }),
    );

    expect(await response?.json()).toMatchObject({
      access: {
        publicBaseUrl: "https://os.example.com",
        webhookBaseUrl: null,
      },
    });
    expect(JSON.parse(readFileSync(paths.config, "utf-8")).server).toEqual({
      publicBaseUrl: "https://os.example.com",
    });
    expect(readFileSync(paths.env, "utf-8")).toContain(
      "# OPENSESSION_WEBHOOK_BASE=https://hooks.example.com",
    );
  });

  test("rejects a private webhook origin without changing config", async () => {
    const paths = fixture();
    const before = readFileSync(paths.config, "utf-8");
    const response = await handleSetupAccessRoutes(
      context({
        publicBaseUrl: "https://os.example.com",
        webhookBaseUrl: "https://hooks.tailnet.ts.net",
      }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "Webhook address must be reachable from the public internet",
    });
    expect(readFileSync(paths.config, "utf-8")).toBe(before);
  });
});
