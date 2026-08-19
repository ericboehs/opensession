import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionCardBody, WsCardBody } from "./HoverCards";
import type { WsCardRow } from "../../lib/sidebar-hover";
import type { UnifiedSession } from "../../lib/types";

// A sibling test may already have installed a partial `window`. Fill in this
// file's browser surface without replacing it.
Object.assign(
	((globalThis as unknown as { window?: Record<string, unknown> }).window ??= {}),
	{ addEventListener: () => {}, matchMedia: () => ({ matches: false }) },
);

const AGO = new Date(Date.now() - 8 * 60_000).toISOString();

function session(extra: Partial<UnifiedSession> = {}): UnifiedSession {
	return {
		id: "os-test",
		title: "Modernize UI design",
		repo: "opensession",
		lastActivity: AGO,
		...extra,
	} as unknown as UnifiedSession;
}

function row(sessions: UnifiedSession[]): WsCardRow {
	return {
		key: "ws-test",
		workspace: null,
		name: "Modernize UI design",
		sessions,
		status: "pending",
		lastActivity: AGO,
		running: false,
	};
}

// The card answers "what is this, and what does it need?". The repo is the
// band the row is already filed under, and an idle "updated 8m ago" is a fact
// the Info tab carries exactly — neither changes what you do next, and on a
// 300px card they were the first and last thing you read.
describe("hover cards drop the repo and the idle timestamp", () => {
	test("the session card leads with neither the repo nor a timestamp", () => {
		const html = renderToStaticMarkup(
			<SessionCardBody session={session()} />,
		);
		expect(html).toContain("Modernize UI design");
		expect(html).not.toContain("opensession");
		expect(html).not.toContain("Updated");
	});

	test("the workspace card leads with neither the repo nor a timestamp", () => {
		const html = renderToStaticMarkup(
			<WsCardBody row={row([session()])} onArchive={() => {}} onOpen={() => {}} />,
		);
		expect(html).toContain("Modernize UI design");
		expect(html).not.toContain("opensession");
		expect(html).not.toContain("Updated");
	});

	test("a card with nothing left to show ends on its content, not an empty strip", () => {
		const html = renderToStaticMarkup(<SessionCardBody session={session()} />);
		expect(html).not.toContain("mt-3.5");
	});

	// A word with no descenders ("Archive", "#5675") leaves the line box's
	// reserved descender space empty, so centring the box puts the ink most of
	// a pixel high on the plate. The label carries CAP_LABEL to centre the ink
	// itself; it has to be a span, because the trim is a no-op on the control's
	// own flex box.
	test("the archive action centres its word on the cap band", () => {
		const html = renderToStaticMarkup(
			<WsCardBody
				row={{ ...row([session()]), status: "merged" }}
				onArchive={() => {}}
				onOpen={() => {}}
			/>,
		);
		expect(html).toMatch(
			new RegExp(`<span class="[^"]*text-box[^"]*">Archive</span>`),
		);
	});

	test("the PR chip centres its number the same way", () => {
		const html = renderToStaticMarkup(
			<SessionCardBody
				session={session({
					prUrl: "https://github.com/tellahq/example/pull/1",
					prNumber: 1,
					prState: "OPEN",
				})}
			/>,
		);
		expect(html).toMatch(
			new RegExp(`<span class="[^"]*text-box[^"]*">#1</span>`),
		);
	});

	test("a diff still holds the head line it shares with the repo's old slot", () => {
		const withPr = session({
			prAdditions: 25,
			prDeletions: 1,
			// Not the fixture's own repo name: the assertion below is about the
			// head line, and a PR link would spell "opensession" out for it.
			prUrl: "https://github.com/tellahq/example/pull/1",
			prNumber: 1,
			prState: "OPEN",
		});
		for (const html of [
			renderToStaticMarkup(<SessionCardBody session={withPr} />),
			renderToStaticMarkup(
				<WsCardBody row={row([withPr])} onArchive={() => {}} onOpen={() => {}} />,
			),
		]) {
			expect(html).toContain("+25");
			expect(html).toContain("-1");
			expect(html).not.toContain("opensession");
		}
	});
});

// The PR is the one place a card leads, so it takes the chip every other PR
// surface draws rather than a dim text link: the number says which PR, the
// colour says how it stands. Both come off the derivation the header uses
// (lib/pr-refs), so the two surfaces cannot disagree about one PR.
describe("the card's PR is the chip the rest of the app draws", () => {
	// The anchor's own tag, so a colour on the status line above it cannot be
	// mistaken for a colour on the chip.
	const chip = (html: string) =>
		html.match(/<a[^>]*href="https:\/\/github[^"]*"[^>]*>/)?.[0] ?? "";

	const cardWithPr = (extra: Partial<UnifiedSession>) =>
		renderToStaticMarkup(
			<SessionCardBody
				session={session({
					prUrl: "https://github.com/tellahq/example/pull/1",
					prNumber: 1,
					prState: "OPEN",
					...extra,
				})}
			/>,
		);

	test("it is a control, and it still leaves for the provider", () => {
		const tag = chip(cardWithPr({}));
		expect(tag).toContain('target="_blank"');
		expect(tag).toContain("min-h-[26px]");
		expect(tag).not.toContain("text-dim");
	});

	test("its colour is the PR's state, not one fixed link colour", () => {
		expect(chip(cardWithPr({}))).toContain("text-green");
		expect(chip(cardWithPr({ prState: "MERGED" }))).toContain("text-purple");
		expect(
			chip(
				cardWithPr({
					prChecks: { total: 2, passed: 1, failed: 1, pending: 0 },
				}),
			),
		).toContain("text-red");
	});
});
