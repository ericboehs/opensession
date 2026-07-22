// Generates the OS1 yin-yang Icon Composer documents (SVG + icon.json) from one
// shared Aqua/Liquid-Glass shading system, so all variants stay consistent.
//
// The seam keeps TRUE yin-yang structure — tangential edge meetings, an
// inflection through the canvas center, two symmetric interlocking heads — but
// the bulge depth is a parameter (1 = classic half-circles, which read as too
// bulbous on a squircle; ~0.5 is the subtle version). Built from cubic Béziers
// so per-variant rotation is exact (Béziers are affine-invariant). Where a
// rotation moves a seam endpoint off the squircle edge, the seam extends along
// its end tangent to the edge.
//
// Run: bun run generate.ts   (from output/os1-icons)

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = import.meta.dir;
const C = 512; // canvas center
const BULGE = 0.6; // 1 = classic semicircle seam; lower = subtler S
const H = (4 / 3) * 256 * BULGE; // Bézier control offset (max lateral bulge ~ 0.75*H)
// With a sub-classic bulge, a horizontal tangent at the center inflection reads
// as a pinched kink; V angles that tangent for a smooth flowing S.
const V = 180;

// Squircle corner arcs (1024 canvas, r=240)
const TL = "C0 107 107 0 240 0";
const BR = "C1024 917 917 1024 784 1024";
const BL = "C107 1024 0 917 0 784";
const SQUIRCLE =
  "M240 0h544c133 0 240 107 240 240v544c0 133-107 240-240 240H240C107 1024 0 917 0 784V240C0 107 107 0 240 0Z";

const deg = (d: number) => (d * Math.PI) / 180;
// Visually-counterclockwise rotation around canvas center (y-down coords).
function rot(p: [number, number], theta: number): [number, number] {
  const [rx, ry] = [p[0] - C, p[1] - C];
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return [rx * cos + ry * sin + C, -rx * sin + ry * cos + C];
}
const f = (n: number) => Math.round(n * 10) / 10;
const pt = (p: [number, number]) => `${f(p[0])} ${f(p[1])}`;

// Canonical seam (theta = 0): enters top center, upper head bulges LEFT,
// horizontal tangent through the center inflection, lower head bulges RIGHT,
// exits bottom center. White (pearl) lobe is everything on the left side.
function seamFor(thetaDeg: number): { seam: string; start: [number, number]; end: [number, number] } {
  const theta = deg(thetaDeg);
  const p0 = rot([C, 0], theta);
  const c1 = rot([C - H, 0], theta);
  const c2 = rot([C - H, 1024 / 2 - V], theta);
  const pm = rot([C, C], theta); // center inflection (rotation-invariant)
  const c3 = rot([C + H, 1024 / 2 + V], theta);
  const c4 = rot([C + H, 1024], theta);
  const p1 = rot([C, 1024], theta);

  const curve = `C${pt(c1)} ${pt(c2)} ${pt(pm)}C${pt(c3)} ${pt(c4)} ${pt(p1)}`;

  if (thetaDeg === 90) {
    // Endpoints land exactly on the left/right edges — no extension needed.
    return { seam: `M${pt(p0)}${curve}`, start: p0, end: p1 };
  }

  // Extend tangentially to the top/bottom edges (tangent at the seam ends is
  // the rotated horizontal).
  const dir: [number, number] = [Math.cos(theta), -Math.sin(theta)];
  const tTop = Math.abs(Math.sin(theta)) < 1e-9 ? 0 : p0[1] / Math.sin(theta);
  const start: [number, number] = [p0[0] + dir[0] * tTop, 0];
  const tBot = Math.abs(Math.sin(theta)) < 1e-9 ? 0 : (1024 - p1[1]) / Math.sin(theta);
  const end: [number, number] = [p1[0] - dir[0] * tBot, 1024];

  const lead = tTop > 0.5 ? `M${pt(start)}L${pt(p0)}` : `M${pt(p0)}`;
  const tail = tBot > 0.5 ? `L${pt(end)}` : "";
  return { seam: `${lead}${curve}${tail}`, start, end };
}

type Variant = {
  dir: string;
  svg: string;
  layerName: string;
  preview: string;
  thetaDeg: number;
  seam: string;
  lobe: string;
};

function vertical(dir: string, svg: string, layerName: string, preview: string, thetaDeg: number): Variant {
  const s = seamFor(thetaDeg);
  // Close along bottom edge -> BL corner -> left edge -> TL corner -> top edge.
  const lobe = `${s.seam}L240 1024${BL}L0 240${TL}Z`;
  return { dir, svg, layerName, preview, thetaDeg, seam: s.seam, lobe };
}

// The chosen icon: pure vertical seam. (Rotated and horizontal variants were
// explored and dropped 2026-07-22 — seamFor() still takes any angle, and a
// horizontal variant additionally needs a different lobe closure along the
// bottom edge via the BR corner arc.)
const meridian = vertical("OS1Meridian.icon", "meridian.svg", "Classic yin-yang, vertical", "os1-meridian", 0);

const variants = [meridian];

function svgFor(v: Variant): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="smoke" cx="30%" cy="8%" r="115%">
      <stop offset="0" stop-color="#33414a"/>
      <stop offset="0.35" stop-color="#121b21"/>
      <stop offset="0.7" stop-color="#070c10"/>
      <stop offset="1" stop-color="#010204"/>
    </radialGradient>
    <radialGradient id="pearl" cx="28%" cy="74%" r="88%">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="0.45" stop-color="#f4f9fa"/>
      <stop offset="0.8" stop-color="#d7e1e5"/>
      <stop offset="1" stop-color="#b6c4cb"/>
    </radialGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.34"/>
      <stop offset="0.72" stop-color="#e6fbff" stop-opacity="0.09"/>
      <stop offset="1" stop-color="#e6fbff" stop-opacity="0"/>
    </linearGradient>
    <filter id="blur28" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="28"/>
    </filter>
    <filter id="blur14" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
    <clipPath id="sq"><path d="${SQUIRCLE}"/></clipPath>
    <clipPath id="lobe"><path d="${v.lobe}"/></clipPath>
  </defs>

  <path fill="url(#smoke)" d="${SQUIRCLE}"/>

  <g clip-path="url(#sq)">
    <path d="${v.seam}" fill="none" stroke="#e8f6f8" stroke-width="30" opacity="0.4" filter="url(#blur14)"/>
  </g>

  <path fill="url(#pearl)" d="${v.lobe}"/>

  <g clip-path="url(#lobe)">
    <path d="${v.seam}" fill="none" stroke="#0b1216" stroke-width="110" opacity="0.34" filter="url(#blur28)"/>
    <path d="${v.seam}" fill="none" stroke="#0b1216" stroke-width="30" opacity="0.3" filter="url(#blur14)"/>
    <path d="${v.seam}" fill="none" stroke="#ffffff" stroke-width="6" opacity="0.5"/>
  </g>

  <path fill="url(#sheen)" clip-path="url(#sq)" d="M0 0H1024V250C820 366 204 366 0 250Z"/>
</svg>
`;
}

function iconJsonFor(v: Variant): string {
  return JSON.stringify(
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
              glass: true,
              hidden: false,
              "image-name": v.svg,
              name: v.layerName,
              opacity: 1,
              position: { scale: 1, "translation-in-points": [0, 0] },
            },
          ],
          name: "Unified Aqua glass",
          mode: "combined",
          specular: true,
          shadow: { kind: "neutral", opacity: 0.14 },
          translucency: { enabled: true, value: 0.3 },
        },
      ],
      "supported-platforms": { squares: "shared" },
    },
    null,
    2,
  );
}

for (const v of variants) {
  const dir = join(ROOT, v.dir);
  mkdirSync(join(dir, "Assets"), { recursive: true });
  writeFileSync(join(dir, "Assets", v.svg), svgFor(v));
  writeFileSync(join(dir, "icon.json"), iconJsonFor(v));
  console.log(`wrote ${v.dir} (theta=${v.thetaDeg})`);
}
