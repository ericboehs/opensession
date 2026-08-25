import { useEffect, useState } from "react";
import heroPosterAsset from "./hero-poster.webp";
import heroPosterDarkAsset from "./hero-poster-dark.webp";
import { assetUrl } from "./asset-url";

const heroPosterUrl = assetUrl(heroPosterAsset);
const heroPosterDarkUrl = assetUrl(heroPosterDarkAsset);

/**
 * Tella's own backgrounds behind the hero: "Silver Silk" in light, "Cobalt
 * Veil" in dark, dimmed in CSS so the same silk reads as a night sky. A <source media> attribute would be the declarative way to
 * pick one, but browsers dropped support for it on <video>, so the choice is
 * made here and the element is keyed on it to force a reload rather than
 * leaving the old frame on screen.
 */
const CLIPS = {
	light: {
		src: "https://ucarecdn.com/b8c1a712-87c2-4884-8034-77e71fa4d7ac/",
		poster: heroPosterUrl,
	},
	dark: {
		src: "https://ucarecdn.com/3e8909cf-5409-40b2-b8d3-8057004e0182/",
		poster: heroPosterDarkUrl,
	},
};

const query = "(prefers-color-scheme: dark)";

export function TellaBackground() {
	const [dark, setDark] = useState(() => window.matchMedia(query).matches);

	useEffect(() => {
		const media = window.matchMedia(query);
		const onChange = (event: MediaQueryListEvent) => setDark(event.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	const clip = dark ? CLIPS.dark : CLIPS.light;

	return (
		<video
			key={dark ? "dark" : "light"}
			className="hero-video"
			autoPlay
			loop
			muted
			playsInline
			poster={clip.poster}
			aria-hidden="true"
		>
			<source src={clip.src} type="video/mp4" />
		</video>
	);
}
