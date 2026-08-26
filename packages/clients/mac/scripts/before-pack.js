const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const root = context.packager.projectDir;
  const outputDir = path.join(root, "build", "vendor");
  const output = path.join(outputDir, "os1-dictation");
  const source = path.join(root, "native", "DictationHelper.swift");
  const info = path.join(root, "native", "DictationHelper-Info.plist");
  fs.mkdirSync(outputDir, { recursive: true });
  execFileSync(
    "xcrun",
    [
      "swiftc",
      source,
      "-parse-as-library",
      "-O",
      "-framework",
      "Speech",
      "-framework",
      "AVFoundation",
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      info,
      "-o",
      output,
    ],
    { stdio: "inherit" },
  );
  fs.chmodSync(output, 0o755);
};
