import type { Metadata, Viewport } from "next";
import "../../setup.css";
import { SetupEntry } from "../legacy-entry";

export const metadata: Metadata = {
  title: "Set up Open Session",
  description: "Set up a private Open Session server on a VPS with Tailscale.",
  alternates: { canonical: "/setup" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#101011" },
  ],
};

export default function SetupPage() {
  return <SetupEntry />;
}
