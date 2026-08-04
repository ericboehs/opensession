import { useEffect, useLayoutEffect, useRef, useState } from "react";
import markUrl from "../os1-mac/build/icon-512.png";

const desktopDemoWidth = 900;

export function ProductDemo({ feature }: { feature: number }) {
	const previewRef = useRef<HTMLElement>(null);
	const frameRef = useRef<HTMLIFrameElement>(null);
	const [ready, setReady] = useState(false);

	const showFeature = () => {
		frameRef.current?.contentWindow?.postMessage(
			{ type: "opensession-demo-feature", feature },
			window.location.origin,
		);
	};

	useEffect(showFeature, [feature]);

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
			showFeature();
		};
		window.addEventListener("message", handleMessage);
		return () => window.removeEventListener("message", handleMessage);
	}, [feature]);

	return (
		<figure ref={previewRef} className="preview-wrap" data-ready={ready}>
			<div
				className="product-demo-loading"
				role="status"
				aria-live="polite"
				aria-hidden={ready}
			>
				<div className="product-demo-loading-sidebar" aria-hidden="true">
					<span />
					<span />
					<span />
					<span />
				</div>
				<div className="product-demo-loading-status">
					<img src={markUrl} alt="" />
					<span>Loading live workspace</span>
				</div>
			</div>
			<iframe
				ref={frameRef}
				className="product-demo-frame"
				title="Interactive OpenSession product preview"
				aria-hidden={!ready}
				tabIndex={ready ? undefined : -1}
				src="/product-demo.html"
				loading="eager"
				referrerPolicy="no-referrer"
				sandbox="allow-scripts allow-same-origin"
				onLoad={showFeature}
			/>
		</figure>
	);
}
