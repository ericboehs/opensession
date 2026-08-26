import type { Viewport } from "next";
import { LandingEntry } from "./legacy-entry";

export const viewport: Viewport = {
  viewportFit: "cover",
  // Safari owns its expanded browser toolbar, so page artwork cannot render
  // inside it. Tint that chrome to the artwork's bottom edge instead of
  // leaving the generic grey site color, which reads as a white bar here.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#84c0e0" },
    { media: "(prefers-color-scheme: dark)", color: "#03314f" },
  ],
};

export default function HomePage() {
  return <LandingEntry />;
}
