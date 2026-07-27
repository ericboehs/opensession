const path = require("node:path");
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

// Mach-O magic numbers (32/64-bit, both endiannesses, fat binaries).
const MACHO_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca,
]);

function isMachO(file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const head = Buffer.alloc(4);
    if (fs.readSync(fd, head, 0, 4, 0) < 4) return false;
    return MACHO_MAGICS.has(head.readUInt32BE(0));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function* machOFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* machOFiles(entryPath);
    else if (entry.isFile() && isMachO(entryPath)) yield entryPath;
  }
}

// Signs the vendored binaries the normal electron-builder signer is told to
// skip (signIgnore in electron-builder.yml): the Bun-based CLI runtimes
// (opencode and bun — both need the JIT entitlement under the hardened
// runtime) and every Mach-O inside the server sidecar's node_modules (libsql
// and friends — plain hardened-runtime signatures, required by notarization).
module.exports = async function signBinaries(context) {
  if (process.platform !== "darwin") return;

  // CI exports APPLE_ID in the builder step, so a missing identity is fatal in
  // releases. Local unsigned builds have no identity and skip cleanly.
  const signingExpected = Boolean(
    process.env.APPLE_ID || process.env.CSC_LINK || process.env.CSC_NAME,
  );

  const productName = context.packager.appInfo.productFilename;
  const resources = path.join(
    context.appOutDir,
    `${productName}.app`,
    "Contents",
    "Resources",
  );
  const jitEntitlements = path.join(
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
        throw new Error("No Developer ID Application identity found for vendored binaries");
      }
      console.log("[sign-binaries] no Developer ID identity; leaving local build unsigned");
      return;
    }
    identity = match[1];
  }

  const sign = (binary, entitlements) => {
    const args = ["--force", "--timestamp", "--options", "runtime"];
    if (entitlements) args.push("--entitlements", entitlements);
    args.push("--sign", identity, binary);
    execFileSync("/usr/bin/codesign", args, { stdio: "inherit" });
  };

  for (const runtime of ["opencode", "bun"]) {
    const binary = path.join(resources, runtime);
    sign(binary, jitEntitlements);
    execFileSync("/usr/bin/codesign", ["--verify", "--strict", "--verbose=2", binary], {
      stdio: "inherit",
    });
  }

  const serverDir = path.join(resources, "server");
  if (fs.existsSync(serverDir)) {
    let signed = 0;
    for (const file of machOFiles(serverDir)) {
      sign(file, null);
      signed++;
    }
    console.log(`[sign-binaries] signed ${signed} Mach-O file(s) in the server sidecar`);
  }
};
