import { ShaderGradient, ShaderGradientCanvas } from "@shadergradient/react";
import { useEffect, useState } from "react";

function useAnimationEnabled(): boolean {
	const [enabled, setEnabled] = useState(false);

	useEffect(() => {
		const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
		const update = () => setEnabled(!reducedMotion.matches && !document.hidden);
		update();
		reducedMotion.addEventListener("change", update);
		document.addEventListener("visibilitychange", update);
		return () => {
			reducedMotion.removeEventListener("change", update);
			document.removeEventListener("visibilitychange", update);
		};
	}, []);

	return enabled;
}

/** Tella's curated "Cotton candy" ShaderGradient preset, unchanged. */
export function TellaBackground() {
	const animate = useAnimationEnabled();

	return (
		<ShaderGradientCanvas
			className="shader-gradient-canvas"
			pixelDensity={1}
			fov={45}
			pointerEvents="none"
			powerPreference="low-power"
		>
			<ShaderGradient
				control="props"
				type="waterPlane"
				animate={animate ? "on" : "off"}
				uTime={0.2}
				uSpeed={0.3}
				uDensity={1}
				uStrength={3}
				uFrequency={5.5}
				uAmplitude={0}
				brightness={1.2}
				grain="off"
				color1="#ebedff"
				color2="#f3f2f8"
				color3="#dbf8ff"
				cAzimuthAngle={180}
				cPolarAngle={120}
				cDistance={2.9}
				cameraZoom={1}
				positionX={0}
				positionY={1.8}
				positionZ={0}
				rotationX={0}
				rotationY={0}
				rotationZ={-90}
				lightType="3d"
				envPreset="city"
				reflection={0.1}
				shader="defaults"
				wireframe={false}
			/>
		</ShaderGradientCanvas>
	);
}
