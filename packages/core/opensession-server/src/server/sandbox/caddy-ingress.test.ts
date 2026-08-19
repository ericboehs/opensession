import { describe, expect, test } from "bun:test";
import {
  caddyIngressSnippet,
  upsertCaddyIngress,
  webhookHostsFromCaddy,
} from "./caddy-ingress";

describe("sandbox Caddy ingress", () => {
	test("generates sandbox transport and workload-identity routes with a webhook fallback", () => {
    const snippet = caddyIngressSnippet("https://hooks.example.com");
    expect(snippet).toContain("hooks.example.com {");
    expect(snippet).toContain("handle /run-ws/*");
    expect(snippet).toContain("handle /rpc-ws");
    expect(snippet).toContain("handle /ingress-health");
		expect(snippet).toContain("handle /workload-identity/*");
		expect(snippet.match(/127\.0\.0\.1:3860/g)?.length).toBe(4);
    expect(snippet).toContain("reverse_proxy 127.0.0.1:3848");
    expect(snippet).not.toContain("3850");
  });

  test("discovers a single webhook host in adapted Caddy JSON", () => {
    expect(
      webhookHostsFromCaddy({
        apps: {
          http: {
            servers: {
              main: {
                routes: [
                  {
                    match: [{ host: ["hooks.example.com"] }],
                    handle: [
                      {
                        handler: "subroute",
                        routes: [
                          {
                            handle: [
                              {
                                handler: "reverse_proxy",
                                upstreams: [{ dial: "127.0.0.1:3848" }],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      }),
    ).toEqual(["hooks.example.com"]);
  });

  test("injects managed routes into an existing webhook host", () => {
    const source = `hooks.example.com {
    handle {
        reverse_proxy localhost:3848
    }
}
`;
    const installed = upsertCaddyIngress(source, "https://hooks.example.com");
    expect(installed).toContain("# BEGIN OPENSESSION SANDBOX INGRESS");
    expect(installed).toContain("handle /run-ws/*");
    expect(installed.match(/hooks\.example\.com \{/g)).toHaveLength(1);
    expect(installed).toContain("reverse_proxy localhost:3848");
    expect(upsertCaddyIngress(installed, "https://hooks.example.com")).toBe(installed);
  });

  test("replaces old prefixed routes instead of preserving aliases", () => {
    const source = `hooks.example.com {
    handle /opensession/run-ws/* {
        reverse_proxy localhost:3860
    }
    handle /backstage/rpc-ws {
        reverse_proxy localhost:3860
    }
    handle { reverse_proxy localhost:3848 }
}
`;
    const installed = upsertCaddyIngress(source, "https://hooks.example.com");
    expect(installed).toContain("handle /run-ws/*");
    expect(installed).toContain("handle /rpc-ws");
    expect(installed).not.toContain("/opensession/run-ws");
    expect(installed).not.toContain("/backstage/rpc-ws");
  });

  test("creates a complete webhook host when one is absent", () => {
    const installed = upsertCaddyIngress(
      "admin.example.com { reverse_proxy 127.0.0.1:3850 }\n",
      "https://hooks.example.com",
    );
    expect(installed).toContain("hooks.example.com {");
    expect(installed).toContain("reverse_proxy 127.0.0.1:3848");
  });
});
