import { describe, expect, test } from "bun:test";
import { handleConnectionsRoutes } from "./connections";
import type { RouteContext } from "./context";

function context(
  path: string,
  method: string,
  authUser?: RouteContext["authUser"],
): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, { method }),
    url,
    path,
    publicPrefix: "",
    authUser,
  };
}

describe("GitHub connection ownership", () => {
  test("requires sign-in before starting a connection", async () => {
    const response = await handleConnectionsRoutes(
      context("/api/connections/github/device", "POST", null),
    );
    expect(response?.status).toBe(403);
  });

  test("cannot disconnect another signed-in user's account", async () => {
    const response = await handleConnectionsRoutes(
      context(
        "/api/connections/github/account/happylinks",
        "DELETE",
        { login: "9ranty", name: "Grant" },
      ),
    );
    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      error: "You can only disconnect your own GitHub account",
    });
  });
});
