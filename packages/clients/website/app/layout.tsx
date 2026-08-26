import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "../site.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://opensession.com"),
  title: "Open Session · Your team’s control room for coding agents",
  description:
    "Open Session is the open-source workspace for running coding agents together on your own infrastructure.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    title: "Open Session · Your team’s control room for coding agents",
    description:
      "Start parallel agents, collaborate with your team, and review and ship every session from one self-hosted workspace.",
    images: [
      {
        url: "/opensession-social-landing.png",
        width: 1200,
        height: 600,
        alt: "Open Session",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Open Session · Your team’s control room for coding agents",
    description:
      "The open-source workspace for teams running coding agents together.",
    images: ["/opensession-social-landing.png"],
  },
  icons: { icon: "/icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#d8d6d1" },
    { media: "(prefers-color-scheme: dark)", color: "#17171a" },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
