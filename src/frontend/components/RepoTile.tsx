import React from "react";

// Deterministic swatch palette shared by the sidebar's person dots and the
// per-repo tiles. The (lowercased) key hashes to a stable color, so each
// teammate/repo keeps the same color everywhere it appears.
export const SWATCH_COLORS = [
	"#e8836b",
	"#6ba5e8",
	"#8ed99c",
	"#e8c46b",
	"#c06be8",
	"#6be8d2",
	"#e86b9c",
	"#a3b86b",
];

export function swatchColor(key: string): string {
	let hash = 0;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 31 + key.charCodeAt(i)) | 0;
	}
	return SWATCH_COLORS[Math.abs(hash) % SWATCH_COLORS.length];
}

export function repoColor(key: string): string {
	return swatchColor(key);
}

// A tiny colored letter-tile standing in for a repo's icon (sidebar Repo
// dropdown, session-header breadcrumb, repo menus). `size` (px) shrinks it for
// tight spots like the phone header's model line; omitted = the 18px default.
// `round` makes it a full circle (e.g. the phone title pill, where it sits
// against the pill's own rounding).
export function RepoTile({
	name,
	size,
	round,
}: {
	name: string;
	size?: number;
	round?: boolean;
}) {
	const style: React.CSSProperties = { background: repoColor(name) };
	if (size) {
		style.width = size;
		style.height = size;
		style.fontSize = Math.round(size * 0.6);
		style.borderRadius = round ? "50%" : Math.max(3, Math.round(size * 0.28));
	} else if (round) {
		style.borderRadius = "50%";
	}
	return (
		<span className="repo-tile" style={style}>
			{(name[0] || "?").toUpperCase()}
		</span>
	);
}
