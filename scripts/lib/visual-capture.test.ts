import { describe, expect, test } from "bun:test";
import {
  captureInitScript,
  captureViewport,
  PHONE_DPR,
  RETINA_DPR,
} from "./visual-capture";

describe("visual capture defaults", () => {
  test("uses Retina rasterization without changing desktop CSS dimensions", () => {
    expect(captureViewport(1440, 900, false)).toEqual({
      width: 1440,
      height: 900,
      deviceScaleFactor: RETINA_DPR,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 900,
    });
  });

  test("uses phone-density rasterization without enabling the Electron shell", () => {
    expect(captureViewport(390, 844).deviceScaleFactor).toBe(PHONE_DPR);
    expect(
      captureInitScript({ theme: "light", electronMaterial: false }),
    ).not.toContain("material-backdrop");
  });

  test("emulates the Mac Electron material and titlebar before first paint", () => {
    const script = captureInitScript({
      theme: "dark",
      electronMaterial: true,
    });
    expect(script).toContain("materialBackdrop: true");
    expect(script).toContain("'MacIntel'");
    expect(script).toContain("'material-backdrop', 'wco'");
    expect(script).toContain("capture-electron-shell");
  });
});
