import heroPosterAsset from "./hero-poster.webp";
import { assetUrl } from "./asset-url";

const heroPosterUrl = assetUrl(heroPosterAsset);

/** Tella's neutral "Silver Silk" background loop. */
export function TellaBackground() {
	return (
		<video
			className="hero-video"
			autoPlay
			loop
			muted
			playsInline
			poster={heroPosterUrl}
			aria-hidden="true"
		>
			<source
				src="https://ucarecdn.com/b8c1a712-87c2-4884-8034-77e71fa4d7ac/"
				type="video/mp4"
			/>
		</video>
	);
}
