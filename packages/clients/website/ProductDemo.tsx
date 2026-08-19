import { useEffect, useLayoutEffect, useRef, useState } from "react";
import posterUrl from "./demo-poster.webp";
import posterDarkUrl from "./demo-poster-dark.webp";
import phoneUrl from "./demo-phone.webp";
import phoneDarkUrl from "./demo-phone-dark.webp";

/* The width the app is laid out at before it is scaled to fit the window, and
   so what decides how large the product reads. The window stands for a
   14-inch MacBook Pro's screen, which is 1512pt across, so this draws the UI
   at 1.2x life size: enough over life to stay readable on a page you look at
   from desk distance, and the same zoom the phone beside it carries. Keep it
   in step with scripts/capture-demo-poster.ts. */
const desktopDemoWidth = 1260;

export function ProductDemo() {
	const previewRef = useRef<HTMLElement>(null);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [ready, setReady] = useState(false);

	useLayoutEffect(() => {
		const preview = previewRef.current;
		if (!preview) return;
		const updateScale = () => {
			const scale = Math.min(1, preview.clientWidth / desktopDemoWidth);
			preview.style.setProperty("--demo-scale", String(scale));
			preview.dataset.scaled = String(scale < 1);
		};
		const observer = new ResizeObserver(updateScale);
		observer.observe(preview);
		updateScale();
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) return;
			if (event.source !== frameRef.current?.contentWindow) return;
			if (event.data?.type !== "opensession-demo-ready") return;
			setReady(true);
		};
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, []);

	return (
		<>
			<figure ref={previewRef} className="preview-wrap" data-ready={ready}>
				{/* Two files, because the preview follows the visitor's system theme.
				    Regenerate both with `bun scripts/capture-demo-poster.ts`. */}
				<picture>
					<source srcSet={posterDarkUrl} media="(prefers-color-scheme: dark)" />
					<img
						className="product-demo-poster"
						src={posterUrl}
						alt="The Open Session workspace: a list of sessions beside a live transcript."
						aria-hidden={ready}
					/>
				</picture>
				<iframe
					ref={frameRef}
					className="product-demo-frame"
					title="Interactive Open Session product preview"
					aria-hidden={!ready}
					tabIndex={ready ? undefined : -1}
					src="/product-demo.html"
					loading="eager"
					referrerPolicy="no-referrer"
					sandbox="allow-scripts allow-same-origin"
				/>
			</figure>

			{/* The same app on a phone, in front of the window. It is a picture
			    rather than a second live app: one bundle is already the heaviest
			    thing on the page, and the point here is that the product is on a
			    phone at all, which a photograph makes as well as a running copy.
			    Re-shot by scripts/capture-demo-poster.ts with the poster. */}
			<picture>
				<source srcSet={phoneDarkUrl} media="(prefers-color-scheme: dark)" />
				<img
					className="demo-phone"
					src={phoneUrl}
					alt="The same session open in Open Session on a phone."
				/>
			</picture>
		</>
	);
}
