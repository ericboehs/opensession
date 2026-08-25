import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { newStylexCollector, stylexCss, stylexTransform } from "../../server/stylex-build";
import { composerBox, composerFlapBorder } from "../lib/composer-classes";

const CSS = new URL("./base.css", import.meta.url);
const SHIPPED = new URL(
	"../components/ShippedChangeComposer.tsx",
	import.meta.url,
);
const COMPOSER = new URL("../components/Composer.tsx", import.meta.url);
const COMPOSER_STYLES = new URL("../lib/composer-classes.ts", import.meta.url).pathname;
const collector = newStylexCollector();
stylexTransform(COMPOSER_STYLES, readFileSync(COMPOSER_STYLES, "utf8"), collector);
const composerCss = stylexCss(collector);

test("phone composers use the same quiet edge as the desktop ring", () => {
	expect(composerCss).toContain(
		"border-color:color-mix(in srgb,var(--composer-border) 35%,transparent)",
	);
	expect(composerFlapBorder).toContain("pwa-composer-edge");
});

test("team note mode stays compact at rest and names itself when expanded", async () => {
	const composer = await Bun.file(COMPOSER).text();
	const minimizedStart = composer.indexOf("const minimized =");
	const minimizedEnd = composer.indexOf(";", minimizedStart);

	expect(minimizedStart).toBeGreaterThan(-1);
	expect(composer.slice(minimizedStart, minimizedEnd)).not.toContain("noteMode");
	expect(composer).toContain("{noteMode && !minimized && (");
	expect(composer).toContain("noteMode && mergeStylexClassName");
	expect(composer).toContain("sx.beforeOpacity100");
});

test("the installed phone composer keeps its add menu and hides only auxiliary controls", async () => {
	const css = await Bun.file(CSS).text();
	const shipped = await Bun.file(SHIPPED).text();
	const composer = await Bun.file(COMPOSER).text();
	const mediaStart = css.indexOf(
		"@media (display-mode: standalone) and (max-width: 720px)",
	);
	const mediaEnd = css.indexOf("\n}\n", mediaStart) + 3;
	const standalonePhone = css.slice(mediaStart, mediaEnd);

	expect(standalonePhone).toContain(".app .composer");
	expect(standalonePhone).toContain(".app .pwa-composer-edge");
	expect(composerFlapBorder).toContain("pwa-composer-edge");
	expect(shipped).toContain("pwa-composer-edge");
	expect(standalonePhone).toContain(
		"border-color: color-mix(in srgb, var(--composer-border) 35%, transparent)",
	);
	expect(standalonePhone).toContain(".app .pwa-composer-auxiliary");
	expect(standalonePhone).toContain("display: none");
	expect(composer.match(/pwa-composer-auxiliary/g)).toHaveLength(2);
	expect(composer).not.toContain("pwa-note-option");
	expect(composer).toContain('mergeStylexClassName("composer-pop-wrap"');
	expect(composer).toContain("sx.relative, sx.inlineFlex, sx.shrink0");
});
