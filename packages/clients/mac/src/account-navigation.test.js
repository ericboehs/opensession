const { describe, expect, test } = require("bun:test");
const { resumableAccountUrl } = require("./account-navigation");

describe("resumableAccountUrl", () => {
  test("retains an in-app route exactly", () => {
    expect(
      resumableAccountUrl(
        "https://one.example/",
        "https://one.example/workspace/ws-1/session/os-1?tab=changes#latest",
      ),
    ).toBe("https://one.example/workspace/ws-1/session/os-1?tab=changes#latest");
  });

  test("rejects another account and shell pages", () => {
    expect(
      resumableAccountUrl(
        "https://one.example/",
        "https://two.example/session/os-2",
      ),
    ).toBeNull();
    expect(
      resumableAccountUrl("https://one.example/", "file:///offline.html"),
    ).toBeNull();
    expect(
      resumableAccountUrl("https://one.example/", "not a URL"),
    ).toBeNull();
  });
});
