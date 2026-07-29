import React from "react";
import { BRAND_LOGOS } from "../brand-logos";

/** Brand tile colors, keyed by lowercased server/agent name. */
export const BRANDS: Record<string, { bg: string; fg?: string }> = {
  slack: { bg: "#4a154b" },
  linear: { bg: "#5e6ad2" },
  plain: { bg: "#0d9488" },
  sentry: { bg: "#362d59" },
  workos: { bg: "#6363f1" },
  tinybird: { bg: "#27f795", fg: "#08080a" },
  stripe: { bg: "#635bff" },
  amplitude: { bg: "#2d6ff7" },
  grafana: { bg: "#f46800" },
  "grafana-poller": { bg: "#f46800" },
  github: { bg: "#24292e" },
  incident: { bg: "#f25533" },
  ahrefs: { bg: "#ff6b00" },
  circle: { bg: "#6c47ff" },
};

/** Pretty display names for the handful that don't title-case cleanly. */
const DISPLAY_NAMES: Record<string, string> = {
  workos: "WorkOS",
  posthog: "PostHog",
  github: "GitHub",
  "grafana-poller": "Grafana Poller",
  incident: "incident.io",
};

export function displayName(name: string): string {
  return DISPLAY_NAMES[name.toLowerCase()] || name.charAt(0).toUpperCase() + name.slice(1);
}

/** Rounded brand square with the service's real logo (falls back to the first
 * letter on a neutral tile). Shared by the Connections page and the
 * connected-services picker so both read the same. */
export function IconTile({ name, size = 34 }: { name: string; size?: number }) {
  const key = name.toLowerCase();
  const brand = BRANDS[key];
  // Agents like "grafana-poller" reuse the base brand's logo.
  const logo = BRAND_LOGOS[key] || BRAND_LOGOS[key.split("-")[0]];
  return (
    <span
      className="flex flex-shrink-0 items-center justify-center rounded-[9px] font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: brand?.bg || "var(--bg-active)",
        color: brand?.fg || (brand ? "#fff" : "var(--text-dim)"),
      }}
    >
      {logo ? (
        <svg
          viewBox={logo.viewBox}
          width={size * 0.56}
          height={size * 0.56}
          fill="currentColor"
          aria-hidden="true"
        >
          {logo.paths.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </span>
  );
}
