// Synchronize the approved native app-icon master into the Icon Composer
// document used by the Electron shell on macOS 26+.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const source = join(
  root,
  "../../packages/clients/ios/OS1/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png",
);
const iconDir = join(root, "OS1Meridian.icon");
const assetsDir = join(iconDir, "Assets");

mkdirSync(assetsDir, { recursive: true });
rmSync(join(assetsDir, "meridian.svg"), { force: true });
copyFileSync(source, join(assetsDir, "meridian.png"));

writeFileSync(
  join(iconDir, "icon.json"),
  `${JSON.stringify(
    {
      fill: "system-dark",
      groups: [
        {
          layers: [
            {
              "blend-mode-specializations": [
                { value: "normal" },
                { appearance: "dark", value: "normal" },
              ],
              glass: false,
              hidden: false,
              "image-name": "meridian.png",
              name: "Approved full-bleed OS1 artwork",
              opacity: 1,
              position: { scale: 1, "translation-in-points": [0, 0] },
            },
          ],
          name: "OS1 artwork",
          mode: "combined",
          specular: false,
          translucency: { enabled: false, value: 0 },
        },
      ],
      "supported-platforms": { squares: "shared" },
    },
    null,
    2,
  )}\n`,
);

console.log("synchronized OS1Meridian.icon from the native 1024px master");
