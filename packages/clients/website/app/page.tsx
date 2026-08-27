import type { Viewport } from "next";
import { LandingEntry } from "./legacy-entry";

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": "https://www.opensession.com/#organization",
      name: "Tella",
      url: "https://tella.com",
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://www.opensession.com/#software",
      name: "Open Session",
      url: "https://www.opensession.com",
      description:
        "The open-source workspace for teams running coding agents together on their own infrastructure.",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web, macOS, Windows",
      isAccessibleForFree: true,
      license: "https://github.com/tellahq/opensession/blob/main/LICENSE",
      codeRepository: "https://github.com/tellahq/opensession",
      creator: { "@id": "https://www.opensession.com/#organization" },
    },
  ],
};

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
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <LandingEntry />
    </>
  );
}
