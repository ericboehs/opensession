const path = require("node:path");
const { execFileSync } = require("node:child_process");

module.exports = async function signOpencode(context) {
  if (process.platform !== "darwin") return;

  // CI exports APPLE_ID in the builder step, so a missing identity is fatal in
  // releases. Local unsigned builds have no identity and skip cleanly.
  const signingExpected = Boolean(
    process.env.APPLE_ID || process.env.CSC_LINK || process.env.CSC_NAME,
  );

  const productName = context.packager.appInfo.productFilename;
  const binary = path.join(
    context.appOutDir,
    `${productName}.app`,
    "Contents",
    "Resources",
    "opencode",
  );
  const entitlements = path.join(
    context.packager.projectDir,
    "build",
    "entitlements.opencode.plist",
  );
  let identity = process.env.CSC_NAME;
  if (!identity) {
    let identities = "";
    try {
      identities = execFileSync(
        "/usr/bin/security",
        ["find-identity", "-v", "-p", "codesigning"],
        { encoding: "utf8" },
      );
    } catch (error) {
      if (signingExpected) throw error;
    }
    const match = identities.match(/\b([A-Fa-f0-9]{40})\s+"Developer ID Application:[^"]+"/);
    if (!match) {
      if (signingExpected) {
        throw new Error("No Developer ID Application identity found for OpenCode");
      }
      console.log("[sign-opencode] no Developer ID identity; leaving local build unsigned");
      return;
    }
    identity = match[1];
  }

  execFileSync(
    "/usr/bin/codesign",
    [
      "--force",
      "--timestamp",
      "--options",
      "runtime",
      "--entitlements",
      entitlements,
      "--sign",
      identity,
      binary,
    ],
    { stdio: "inherit" },
  );
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", binary], {
    stdio: "inherit",
  });
};
