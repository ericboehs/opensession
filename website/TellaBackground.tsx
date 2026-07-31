import springPosterUrl from "./spring-poster.webp";

export function TellaBackground() {
	return (
		<video
			className="hero-video"
			autoPlay
			loop
			muted
			playsInline
			poster={springPosterUrl}
			aria-hidden="true"
		>
			<source
				src="https://ucarecdn.com/f2866028-02b6-4217-baeb-908da0806fea/"
				type="video/mp4"
			/>
		</video>
	);
}
