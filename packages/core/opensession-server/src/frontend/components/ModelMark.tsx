import React from "react";
import { modelBrandKeys } from "../lib/model-brand";
import { BrandMark } from "./BrandMark";

/**
 * The vendor marks behind a model choice, so every model dropdown draws brands
 * one way (the same registry the Connections cards and engine pickers use).
 * Cross-vendor presets show a compact pair; same-vendor combos keep one mark.
 */
export function ModelMark({
	id,
	provider,
	composition,
	size = 15,
}: {
	id: string;
	provider?: string;
	composition?: string[];
	size?: number;
}) {
	const keys = modelBrandKeys(id, provider, composition);
	if (keys.length === 0) return null;
	if (keys.length === 1) return <BrandMark name={keys[0]} size={size} />;

	const pairedSize = Math.round(size * 0.67);
	return (
		<span className="inline-flex items-center gap-0.5" aria-hidden="true">
			{keys.slice(0, 2).map((key) => (
				<BrandMark key={key} name={key} size={pairedSize} />
			))}
		</span>
	);
}
