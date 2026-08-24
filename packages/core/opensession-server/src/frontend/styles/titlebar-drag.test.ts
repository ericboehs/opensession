import { expect, test } from "bun:test";

const HTML = new URL("../index.html", import.meta.url);
const CSS = new URL("./base.css", import.meta.url);
const USER_PICKER = new URL("../components/UserPicker.tsx", import.meta.url);
const APP = new URL("../App.tsx", import.meta.url);

test("Electron titlebar drag regions do not depend on WCO visibility", async () => {
	const [html, css, userPicker, app] = await Promise.all([
		Bun.file(HTML).text(),
		Bun.file(CSS).text(),
		Bun.file(USER_PICKER).text(),
		Bun.file(APP).text(),
	]);

	expect(html).toContain('window.os1.desktop === true');
	expect(html).toContain('classList.add("desktop-shell")');
	expect(css).toContain(
		"html:is(.wco, .desktop-shell) .wco-chrome {\n\t-webkit-app-region: drag;",
	);
	expect(css).toContain(
		"html:is(.wco, .desktop-shell):has(.app-menu-popup:not([hidden])) .wco-chrome",
	);
	expect(css).not.toContain("html.wco:has(.app-menu-popup) .wco-chrome");
	expect(css).toContain(
		"html:is(.wco, .desktop-shell) .app-body.sidebar-collapsed .detail-pane .wco-nav-pane",
	);
	expect(userPicker).toContain(
		"[html.desktop-shell_&]:[-webkit-app-region:drag]",
	);
	expect(app).toContain('className="wco-collapsed-drag-handle"');
	expect(css).toContain(
		".app-body.sidebar-collapsed\n\t.wco-collapsed-drag-handle",
	);
});
