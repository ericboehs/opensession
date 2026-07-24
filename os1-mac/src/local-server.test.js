const { describe, expect, test } = require("bun:test");
const { configForCloudSession } = require("./local-server.js");

describe("local server cloud identity", () => {
  test("uses only the active Electron cloud cookie", () => {
    expect(
      configForCloudSession(
        { serverDir: "/tmp/server", cloudToken: "stale-setting" },
        " active-cookie ",
      ),
    ).toEqual({ serverDir: "/tmp/server", cloudToken: "active-cookie" });
  });

  test("clears stale configured credentials when the cookie is absent", () => {
    expect(configForCloudSession({ cloudToken: "stale-setting" }, null)).toEqual({
      cloudToken: "",
    });
  });
});
