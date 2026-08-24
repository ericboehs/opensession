import { useMemo } from "react";

/**
 * The page's ground: a stack of hand-drawn bands run through one turbulence
 * filter, so the whole site sits on a marbled field rather than on white.
 *
 * Three things keep it cheap. The bands are plain paths, so the browser paints
 * them once; the filter is static, so nothing re-renders on scroll; and the
 * layer is fixed, so scrolling composites rather than repaints. The seed is
 * fixed too, which matters more than it looks: a random field would draw a
 * different page on every load and make every visual capture useless.
 */
const PALETTE = [
	"#0e2f8f",
	"#2a5fe0",
	"#f4efe6",
	"#e7a7c2",
	"#5d3a2b",
	"#1747c9",
	"#8fb4f5",
	"#3b2118",
	"#123ab5",
	"#c9d8f7",
];

const WIDTH = 1440;
const HEIGHT = 1200;

type Band = { d: string; fill: string; opacity: string };

/** A linear congruential generator: same seed, same field, every load. */
function buildBands(seed: number): Band[] {
	let state = seed * 9973;
	const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

	const out: Band[] = [];
	let y = -160;
	while (y < HEIGHT + 200) {
		const thickness = 6 + rand() * 46;
		const fill = PALETTE[Math.floor(rand() * PALETTE.length)] as string;
		const amp = 20 + rand() * 70;
		const phase = rand() * 6.28;
		// Two sines of different wavelength: the long one gives the band its
		// drift, the short one the wobble that stops it reading as a graph.
		const at = (x: number) =>
			y + Math.sin(x / 260 + phase) * amp * 0.5 + Math.sin(x / 90 + phase) * amp * 0.18;

		let d = `M -220 ${at(-220).toFixed(1)}`;
		for (let x = -220; x <= WIDTH + 260; x += 60) d += ` L ${x} ${at(x).toFixed(1)}`;
		for (let x = WIDTH + 260; x >= -220; x -= 60)
			d += ` L ${x} ${(at(x) + thickness).toFixed(1)}`;
		out.push({ d: `${d} Z`, fill, opacity: (0.5 + rand() * 0.5).toFixed(2) });
		y += thickness * (0.55 + rand() * 0.9);
	}
	return out;
}

export function MarbleField() {
	const bands = useMemo(() => buildBands(11), []);

	return (
		<div className="field" aria-hidden="true">
			<svg
				className="field-paint"
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				preserveAspectRatio="xMidYMid slice"
			>
				<defs>
					<filter id="field-swirl" x="-20%" y="-20%" width="140%" height="140%">
						<feTurbulence
							type="fractalNoise"
							baseFrequency="0.0018 0.021"
							numOctaves={4}
							seed={11}
							result="noise"
						/>
						<feDisplacementMap
							in="SourceGraphic"
							in2="noise"
							scale={150}
							xChannelSelector="R"
							yChannelSelector="G"
						/>
						<feGaussianBlur stdDeviation={0.6} />
					</filter>
				</defs>
				<rect width={WIDTH} height={HEIGHT} fill="#123ab5" />
				<g filter="url(#field-swirl)">
					{bands.map((band) => (
						<path key={band.d} d={band.d} fill={band.fill} opacity={band.opacity} />
					))}
				</g>
			</svg>
			{/* Canvas grain. Without it the bands read as vector gradients rather
			    than as paint, which is the whole point of the field. */}
			<svg className="field-grain">
				<filter id="field-grain-noise">
					<feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves={3} />
				</filter>
				<rect width="100%" height="100%" filter="url(#field-grain-noise)" />
			</svg>
		</div>
	);
}
