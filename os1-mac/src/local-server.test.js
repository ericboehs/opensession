const { describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { configForCloudSession, resolveServerSource } = require("./local-server.js");

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

describe("server source resolution", () => {
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "os1-server-"));
  const seed = (dir, file) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, file), "");
    return dir;
  };

  test("prefers the ~/os1/server checkout over the bundled sidecar", () => {
    const home = scratch();
    const resources = scratch();
    seed(path.join(home, "os1", "server"), "opensession.ts");
    seed(path.join(resources, "server"), "opensession.js");
    expect(resolveServerSource({}, resources, home)).toEqual({
      serverDir: path.join(home, "os1", "server"),
      entry: "opensession.ts",
      kind: "source",
    });
  });

  test("falls back to the bundled sidecar when no checkout exists", () => {
    const home = scratch();
    const resources = scratch();
    seed(path.join(resources, "server"), "opensession.js");
    expect(resolveServerSource({}, resources, home)).toEqual({
      serverDir: path.join(resources, "server"),
      entry: "opensession.js",
      kind: "sidecar",
    });
  });

  test("a configured serverDir accepts either layout and never falls through", () => {
    const home = scratch();
    const resources = scratch();
    seed(path.join(resources, "server"), "opensession.js");
    const configured = seed(scratch(), "opensession.js");
    expect(resolveServerSource({ serverDir: configured }, resources, home)).toEqual({
      serverDir: configured,
      entry: "opensession.js",
      kind: "sidecar",
    });
    expect(() => resolveServerSource({ serverDir: path.join(configured, "missing") }, resources, home)).toThrow(
      /server source is missing/,
    );
  });

  test("errors when neither a checkout nor a bundled sidecar exists", () => {
    expect(() => resolveServerSource({}, scratch(), scratch())).toThrow(
      /no bundled server in this build/,
    );
  });
});
