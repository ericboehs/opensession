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
				src="https://ucarecdn.com/ab5e84d3-00af-456a-b821-da86f7b23be8/"
				type="video/mp4"
			/>
		</video>
	);
}
