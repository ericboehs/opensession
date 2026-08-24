import { describe, expect, test } from "bun:test";
import { resolveServerUrl } from "./server-url";

describe("resolveServerUrl", () => {
  test("prints the configured public URL", () => {
    expect(
      resolveServerUrl({
        server: {
          host: "127.0.0.1",
          port: 3850,
          publicBaseUrl: "https://sessions.example.test/",
        },
      }),
    ).toBe("https://sessions.example.test");
  });

  test("service env values override config", () => {
    expect(
      resolveServerUrl(
        {
          server: {
            host: "127.0.0.1",
            port: 3850,
            publicBaseUrl: "https://old.example.test",
          },
        },
        {
          HOST: "100.64.0.4",
          PORT: "4000",
          OPENSESSION_UI_BASE: "https://sessions.example.test",
        },
      ),
    ).toBe("https://sessions.example.test");
  });

  test("turns a wildcard bind into a usable fallback URL", () => {
    expect(resolveServerUrl({ server: { host: "0.0.0.0", port: 4100 } })).toBe(
      "http://127.0.0.1:4100",
    );
  });
});
