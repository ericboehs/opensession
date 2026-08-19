import { expect, test } from "bun:test";
import { pwaManifest } from "./static-assets";

test("PWA manifest includes a new-agent shortcut under the active prefix", () => {
	const manifest = pwaManifest("/backstage");
	expect(manifest.background_color).toBe("#1c1c1c");
	expect(manifest.theme_color).toBe("#222222");
	expect(manifest.shortcuts).toEqual([
		{
			name: "Start an agent",
			url: "/backstage/new",
			icons: [
				{
					src: "/backstage/icon-192.png?v=5",
					sizes: "192x192",
					type: "image/png",
				},
			],
		},
	]);
});
