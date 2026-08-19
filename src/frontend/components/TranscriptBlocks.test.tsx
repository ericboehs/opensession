import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { TranscriptEntry } from "../lib/types";

// A sibling test may already have installed a partial `window`. Fill in this
// file's browser surface without replacing it or depending on test order.
Object.assign(
	((globalThis as unknown as { window?: Record<string, unknown> }).window ??= {}),
	{
		addEventListener: () => {},
		matchMedia: () => ({ matches: false }),
	},
);
Object.assign(
	((globalThis as unknown as { document?: Record<string, unknown> }).document ??=
		{}),
	{
		documentElement: { dataset: {}, style: {} },
		querySelector: () => null,
	},
);
Object.assign(
	((globalThis as unknown as { localStorage?: Record<string, unknown> })
		.localStorage ??= {}),
	{
		getItem: () => null,
		setItem: () => {},
		removeItem: () => {},
	},
);

const { TranscriptBlocks } = await import("./TranscriptBlocks");

/** The two transcript preferences as the browser store holds them: whether a
 *  turn's work shows, and whether that includes its tool calls. Absent is the
 *  default (work "running", tool calls "folded"); an old single value in the
 *  work key still answers both. */
function setTurnPrefs(work: string | null, tools: string | null = null) {
	(globalThis.localStorage as { getItem: (key: string) => string | null }).getItem =
		(key) =>
			key === "opensession-turn-activity"
				? work
				: key === "opensession-tool-calls"
					? tools
					: null;
}

const entries: TranscriptEntry[] = [
	{
		id: "merged-notice",
		type: "user",
		content: '[GitHub] PR #5606 "Improve the toggle" was merged into main by Kent.',
		timestamp: "2026-08-11T12:50:45Z",
		notice: { kind: "system", title: "PR merged", tone: "info" },
	},
	{
		id: "merged-answer",
		type: "assistant",
		content: "PR #5606 is merged into main by Kent.",
		timestamp: "2026-08-11T12:50:56Z",
	},
	{
		id: "deployment-notice",
		type: "user",
		content: "Deployment finished for PR #5606.",
		timestamp: "2026-08-11T12:56:31Z",
		notice: { kind: "system", title: "Deployment finished", tone: "info" },
	},
];

describe("TranscriptBlocks shipped change action", () => {
	test("places the Slack composer after the merged response", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={entries}
				slackShare={{
					prNumber: 5606,
					sessionId: "session-1",
					defaultMessage: "We updated the toggle style in Tella.",
					screenshot: "/tmp/toggle-after.png",
					status: "idle",
					onShare: () => {},
				}}
			/>,
		);
		expect(html.indexOf("PR #5606 is merged")).toBeLessThan(
			html.indexOf("Send to Slack"),
		);
		expect(html.indexOf("Send to Slack")).toBeLessThan(
			html.indexOf("Deployment finished"),
		);
		expect(html).toContain("We updated the toggle style in Tella.");
		expect(html).toContain("Send to Slack");
		expect(html).toContain('data-brand="slack"');
		expect(html).toContain("%2Ftmp%2Ftoggle-after.png");
		expect(html).toContain('aria-label="Open screenshot preview"');
		expect(html).toContain('aria-label="Remove screenshot"');
		expect(html).toContain("group/image");
		expect(html).toContain("group-hover/image:opacity-100");
		expect(html).toContain('aria-label="Add images"');
		expect(html).toContain('aria-label="Slack channel"');
		expect(html).toContain("border-line bg-surface");
		// The channel picker is the app's own select (ui/select), not a bare
		// <select> with an overlaid chevron.
		expect(html).toContain('role="combobox"');
		expect(html).toContain("rounded-[var(--composer-radius)]");
		expect(html).toContain("smooth-shadow-ring-soft");
		expect(html).not.toContain("rounded-xl bg-panel p-4");
	});

	test("finds the PR in the short merge wording too", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={entries.map((e) =>
					e.id === "merged-notice"
						? { ...e, content: "[GitHub] PR #5606 merged by Kent. Deploying. No action needed." }
						: e,
				)}
				slackShare={{
					prNumber: 5606,
					sessionId: "session-1",
					defaultMessage: "We updated the toggle style in Tella.",
					status: "idle",
					onShare: () => {},
				}}
			/>,
		);
		expect(html).toContain("Send to Slack");
	});

	test("keeps image attachment explicit when no screenshot exists", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={entries}
				slackShare={{
					prNumber: 5606,
					sessionId: "session-1",
					defaultMessage: "Background names are now visible in tooltips.",
					status: "idle",
					onShare: () => {},
				}}
			/>,
		);
		expect(html).toContain('aria-label="Add images"');
		expect(html).not.toContain("Capture screenshot");
		expect(html).not.toContain("Capturing screenshot");
	});

	test("confirms the send and offers another message", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={entries}
				slackShare={{
					prNumber: 5606,
					sessionId: "session-1",
					defaultMessage: "We updated the toggle style in Tella.",
					status: "idle",
					onShare: () => {},
					sent: { channelName: "chat" },
				}}
			/>,
		);
		expect(html).toContain("Sent to");
		expect(html).toContain("#chat");
		expect(html).toContain("Send another");
		expect(html).not.toContain('aria-label="Slack message"');
	});

	test("does not show the action for a different merged PR", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={entries}
				slackShare={{
					prNumber: 5607,
					sessionId: "session-1",
					defaultMessage: "We shipped another update.",
					status: "idle",
					onShare: () => {},
				}}
			/>,
		);
		expect(html).not.toContain("Send to Slack");
	});
});

describe("TranscriptBlocks sent message actions", () => {
	test("offers edit and send again only on the current viewer's messages", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				owner="Anonymous"
				onEditMessage={() => {}}
				entries={[
					{
						id: "mine",
						type: "user",
						content: "Fix the typo",
						timestamp: "2026-08-12T12:00:00Z",
					},
					{
						id: "theirs",
						type: "user",
						content: "A teammate's message",
						timestamp: "2026-08-12T12:01:00Z",
						sender: "Ada",
					},
				]}
			/>,
		);
		expect(html.match(/aria-label="Edit and send again"/g)).toHaveLength(1);
	});
});

describe("TranscriptBlocks compact tool runs", () => {
	const toolEntries: TranscriptEntry[] = [
		{ id: "prompt", type: "user", content: "Check the repository", timestamp: "2026-08-13T06:00:00Z" },
		{ id: "bash", type: "tool_use", toolUseId: "bash-call", toolName: "bash", toolInput: { command: "git status" }, content: "Using bash", timestamp: "2026-08-13T06:00:01Z" },
		{ id: "bash-result", type: "tool_result", toolUseId: "bash-call", content: "clean", timestamp: "2026-08-13T06:00:02Z" },
		{ id: "read", type: "tool_use", toolUseId: "read-call", toolName: "read", toolInput: { filePath: "/tmp/package.json" }, content: "Using read", timestamp: "2026-08-13T06:00:03Z" },
		{ id: "read-result", type: "tool_result", toolUseId: "read-call", content: "{}", timestamp: "2026-08-13T06:00:04Z" },
	];

	/** A second routine call and its result. Grouping starts at two, so a run
	 *  that has to stay folded needs one of these beside the pair above. */
	const bashCall = (n: number, command: string): TranscriptEntry[] => [
		{ id: `bash-${n}`, type: "tool_use", toolUseId: `bash-call-${n}`, toolName: "bash", toolInput: { command }, content: "Using bash", timestamp: `2026-08-13T06:01:0${n}.000Z` },
		{ id: `bash-result-${n}`, type: "tool_result", toolUseId: `bash-call-${n}`, content: "ok", timestamp: `2026-08-13T06:01:0${n}.500Z` },
	];

	test("folds routine calls to one icon-led row by default", () => {
		setTurnPrefs(null);
		const html = renderToStaticMarkup(
			<TranscriptBlocks live entries={toolEntries} />,
		);

		expect(html).toContain('data-tool-run="true"');
		// The folded row is the count and nothing else: which tools ran is
		// what it folds away, and the names are left to the aria-label.
		expect(html).toContain("2 steps</span>");
		expect(html).toContain("Show 2 grouped steps: Bash · Read");
		expect(html).toContain('x="8.25" y="4.75" width="11" height="11" rx="2"');
		expect(html).toContain("group-hover:opacity-0");
		expect(html).toContain("group-hover:opacity-100");
		expect(html).not.toContain("git status");
		expect(html).not.toContain("package.json");
	});

	test("leaves a lone routine call as its own row", () => {
		setTurnPrefs(null);
		const html = renderToStaticMarkup(
			<TranscriptBlocks live entries={toolEntries.slice(0, 3)} />,
		);

		// No fold: a lone call's own row already says more than "1 step".
		expect(html).not.toContain('data-tool-run="true"');
		expect(html).toContain("git status");
	});

	test("folds edits into the run and counts their lines on the row", () => {
		setTurnPrefs(null);
		const edit = (n: number, path: string): TranscriptEntry[] => [
			{ id: `edit-${n}`, type: "tool_use", toolUseId: `edit-call-${n}`, toolName: "edit", toolInput: { filePath: path, oldString: "old", newString: "new" }, content: "Using edit", timestamp: `2026-08-13T06:00:0${n}.000Z` },
			{ id: `edit-result-${n}`, type: "tool_result", toolUseId: `edit-call-${n}`, content: "updated", timestamp: `2026-08-13T06:00:0${n}.500Z` },
		];
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				live
				entries={[
					{ id: "prompt", type: "user", content: "Rework the button", timestamp: "2026-08-13T06:00:00Z" },
					...edit(1, "/tmp/button.tsx"),
					...edit(2, "/tmp/button.tsx"),
					...edit(3, "/tmp/other.tsx"),
					...bashCall(1, "bun test"),
				]}
			/>,
		);

		// One row for the whole run, edits included, carrying the lines those
		// edits moved. The individual edit rows are behind it; the turn's own
		// file chips still name what changed.
		expect(html.match(/data-tool-run="true"/g)).toHaveLength(1);
		expect(html).toContain("4 steps");
		expect(html).toContain("+3");
		expect(html).toContain("-3");
		expect(html).toContain("Show 4 grouped steps: Edit ×3 · Bash");
		expect(html).not.toContain('data-eid="edit-1"');
	});

	test("shows every call in place under the always-expanded preference", () => {
		setTurnPrefs("expanded");
		const html = renderToStaticMarkup(
			<TranscriptBlocks live entries={toolEntries} />,
		);

		// Nothing to disclose, so no grouped row and no indent under one.
		expect(html).not.toContain('data-tool-run="true"');
		expect(html).not.toContain('class="ml-3"');
		expect(html).toContain("git status");
		expect(html).toContain("package.json");
		setTurnPrefs(null);
	});

	test("keeps intermediate messages between compact runs", () => {
		setTurnPrefs(null);
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				live
				entries={[
					...toolEntries,
					{ id: "note", type: "assistant", content: "The repository is clean.", timestamp: "2026-08-13T06:00:05Z" },
					...bashCall(1, "bun test"),
					...bashCall(2, "git diff"),
				]}
			/>,
		);

		expect(html).toContain("The repository is clean.");
		expect(html.match(/data-tool-run="true"/g)).toHaveLength(2);
	});

	test("surfaces failure and incidental media status on the compact row", () => {
		setTurnPrefs(null);
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				live
				entries={[
					{ id: "prompt", type: "user", content: "Verify it", timestamp: "2026-08-13T06:00:00Z" },
					{ id: "bash", type: "tool_use", toolUseId: "bash-call", toolName: "bash", toolInput: { command: "bun test" }, content: "Using bash", timestamp: "2026-08-13T06:00:01Z" },
					{ id: "bash-result", type: "tool_result", toolUseId: "bash-call", content: "failed", isError: true, timestamp: "2026-08-13T06:00:02Z" },
					{ id: "read", type: "tool_use", toolUseId: "read-call", toolName: "read", toolInput: { filePath: "/tmp/after.png" }, content: "Using read", timestamp: "2026-08-13T06:00:03Z" },
					{ id: "read-result", type: "tool_result", toolUseId: "read-call", content: "Image read successfully", images: ["/media?path=after.png"], timestamp: "2026-08-13T06:00:04Z" },
				]}
			/>,
		);

		expect(html).toContain("1 failed");
		expect(html).toContain("1 image");
		expect(html).toContain("1 failed, 1 media");
	});

	test("keeps featured media and subagents as direct rows", () => {
		setTurnPrefs("expanded");
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				live
				entries={[
					{ id: "prompt", type: "user", content: "Show it", timestamp: "2026-08-13T06:00:00Z" },
					{ id: "shot", type: "tool_use", toolUseId: "shot-call", toolName: "read", toolInput: { filePath: "/tmp/after.png" }, content: "Using read", timestamp: "2026-08-13T06:00:01Z" },
					{ id: "shot-result", type: "tool_result", toolUseId: "shot-call", content: "Image read successfully", images: ["/media?path=after.png"], featuredMedia: ["/media?path=after.png"], timestamp: "2026-08-13T06:00:02Z" },
					{ id: "worker", type: "tool_use", toolUseId: "worker-call", toolName: "task", toolInput: { description: "Review it" }, content: "Using task", timestamp: "2026-08-13T06:00:03Z" },
				]}
			/>,
		);

		expect(html).not.toContain('data-tool-run="true"');
		expect(html).toContain("after.png");
		expect(html).toContain("task");
		setTurnPrefs(null);
	});
});

describe("TranscriptBlocks turn work and tool call preferences", () => {
	/** A turn that narrates between its steps, so the two preferences have
	 *  something to disagree about: notes to keep and calls to fold. */
	const narratedTurn: TranscriptEntry[] = [
		{ id: "prompt", type: "user", content: "Check the repository", timestamp: "2026-08-19T06:00:00Z" },
		{ id: "bash", type: "tool_use", toolUseId: "bash-call", toolName: "bash", toolInput: { command: "git status" }, content: "Using bash", timestamp: "2026-08-19T06:00:01Z" },
		{ id: "bash-result", type: "tool_result", toolUseId: "bash-call", content: "clean", timestamp: "2026-08-19T06:00:02Z" },
		{ id: "read", type: "tool_use", toolUseId: "read-call", toolName: "read", toolInput: { filePath: "/tmp/package.json" }, content: "Using read", timestamp: "2026-08-19T06:00:03Z" },
		{ id: "read-result", type: "tool_result", toolUseId: "read-call", content: "{}", timestamp: "2026-08-19T06:00:04Z" },
		{ id: "note", type: "assistant", content: "The repository is clean.", timestamp: "2026-08-19T06:00:05Z" },
		{ id: "answer", type: "assistant", content: "All good.", timestamp: "2026-08-19T06:00:06Z" },
	];

	test("keeps grouped calls closed inside steps that stay open", () => {
		setTurnPrefs("open", "folded");
		const html = renderToStaticMarkup(<TranscriptBlocks entries={narratedTurn} />);

		expect(html).toContain("The repository is clean.");
		expect(html).toContain('data-tool-run="true"');
		expect(html).not.toContain("git status");
		expect(html).not.toContain("package.json");
		setTurnPrefs(null);
	});

	test("opens grouped calls independently of the step timing", () => {
		setTurnPrefs("running", "open");
		const html = renderToStaticMarkup(
			<TranscriptBlocks live entries={narratedTurn.slice(0, -1)} />,
		);

		expect(html).not.toContain('data-tool-run="true"');
		expect(html).toContain("git status");
		expect(html).toContain("package.json");
		setTurnPrefs(null);
	});

	test("reads the old always-expanded preference as both controls open", () => {
		setTurnPrefs("expanded");
		const html = renderToStaticMarkup(<TranscriptBlocks entries={narratedTurn} />);

		expect(html).toContain("The repository is clean.");
		expect(html).not.toContain('data-tool-run="true"');
		expect(html).toContain("git status");
		setTurnPrefs(null);
	});

	test("folds the notes away too when the work is always folded", () => {
		setTurnPrefs("folded", "open");
		const html = renderToStaticMarkup(<TranscriptBlocks entries={narratedTurn} />);

		expect(html).toContain("Worked");
		expect(html).not.toContain("The repository is clean.");
		expect(html).not.toContain("git status");
		// The answer is never work, so it stays whatever the turn does.
		expect(html).toContain("All good.");
		setTurnPrefs(null);
	});

	test("opens the outer steps only while a turn runs", () => {
		setTurnPrefs("running", "folded");
		const running = renderToStaticMarkup(
			<TranscriptBlocks live entries={narratedTurn.slice(0, -1)} />,
		);
		expect(running).toContain("The repository is clean.");
		expect(running).toContain('data-tool-run="true"');

		const settled = renderToStaticMarkup(
			<TranscriptBlocks entries={narratedTurn} />,
		);
		expect(settled).not.toContain("The repository is clean.");
		expect(settled).not.toContain("git status");
		setTurnPrefs(null);
	});
});

describe("TranscriptBlocks featured media outlives the fold", () => {
	/** A settled turn: one routine call, then a step that surfaced media. */
	const turn = (result: Partial<TranscriptEntry>): TranscriptEntry[] => [
		{ id: "prompt", type: "user", content: "Show me", timestamp: "2026-08-15T06:00:00Z" },
		{ id: "bash", type: "tool_use", toolUseId: "bash-call", toolName: "bash", toolInput: { command: "bun run capture" }, content: "Using bash", timestamp: "2026-08-15T06:00:01Z" },
		{ id: "bash-result", type: "tool_result", toolUseId: "bash-call", content: "captured", timestamp: "2026-08-15T06:00:02Z" },
		{ id: "shot", type: "tool_use", toolUseId: "shot-call", toolName: "read", toolInput: { filePath: "/tmp/shot.png" }, content: "Using read", timestamp: "2026-08-15T06:00:03Z" },
		{ id: "shot-result", type: "tool_result", toolUseId: "shot-call", content: "Image read successfully", timestamp: "2026-08-15T06:00:04Z", ...result },
		{ id: "answer", type: "assistant", content: "Here it is.", timestamp: "2026-08-15T06:00:05Z" },
	];

	test("keeps a marked screenshot on screen once the turn settles", () => {
		setTurnPrefs(null);
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={turn({
					images: ["/media?path=featured.png"],
					featuredMedia: ["/media?path=featured.png"],
				})}
			/>,
		);

		// The work is folded: no step rows, no command.
		expect(html).toContain("Worked");
		expect(html).not.toContain("bun run capture");
		// The picture the agent asked to show is not work, so it stays.
		expect(html).toContain('src="/media?path=featured.png"');
		expect(html).toContain("md-image");
	});

	test("leaves media the turn merely touched inside the fold", () => {
		setTurnPrefs(null);
		const html = renderToStaticMarkup(
			<TranscriptBlocks entries={turn({ images: ["/media?path=incidental.png"] })} />,
		);

		// A Read of a PNG attaches its image without featuring it. Forty of
		// those in a verification loop must not land on the page.
		expect(html).toContain("Worked");
		expect(html).not.toContain("incidental.png");
	});

	test("shows a featured video with its player", () => {
		setTurnPrefs(null);
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={turn({
					videos: ["/media?path=demo.mp4"],
					featuredMedia: ["/media?path=demo.mp4"],
				})}
			/>,
		);

		expect(html).toContain('src="/media?path=demo.mp4"');
		expect(html).toContain("md-video");
	});

	test("renders one tile for a loop that captured to the same path twice", () => {
		setTurnPrefs(null);
		const shot = (n: number): TranscriptEntry[] => [
			{ id: `shot-${n}`, type: "tool_use", toolUseId: `shot-call-${n}`, toolName: "bash", toolInput: { command: "bun run capture" }, content: "Using bash", timestamp: `2026-08-15T06:0${n}:00Z` },
			{ id: `shot-result-${n}`, type: "tool_result", toolUseId: `shot-call-${n}`, content: "OPENSESSION_IMAGE: /tmp/after.png", images: ["/media?path=after.png"], featuredMedia: ["/media?path=after.png"], timestamp: `2026-08-15T06:0${n}:01Z` },
		];
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={[
					{ id: "prompt", type: "user", content: "Iterate", timestamp: "2026-08-15T06:00:00Z" },
					...shot(1),
					...shot(2),
					{ id: "answer", type: "assistant", content: "Done.", timestamp: "2026-08-15T06:03:00Z" },
				]}
			/>,
		);

		expect(html.match(/src="\/media\?path=after\.png"/g)).toHaveLength(1);
	});

	test("does not repeat the media that its own open row is already showing", () => {
		setTurnPrefs("expanded");
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={turn({
					images: ["/media?path=featured.png"],
					featuredMedia: ["/media?path=featured.png"],
				})}
			/>,
		);

		expect(html).toContain("bun run capture");
		expect(html.match(/src="\/media\?path=featured\.png"/g)).toHaveLength(1);
		setTurnPrefs(null);
	});
});

describe("TranscriptBlocks review loops", () => {
	test("folds review work but leaves a following user request in the conversation", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={[
					{ id: "review", type: "user", content: "[GitHub] <!--os:review-handoff-->\n🔍 This session's PR #42 was just reviewed and is not merge-ready.", timestamp: "2026-08-12T12:00:00Z" },
					{ id: "fix", type: "assistant", content: "Fixed the review finding.", timestamp: "2026-08-12T12:01:00Z" },
					{ id: "human", type: "user", content: "Please also update the empty state.", timestamp: "2026-08-12T12:02:00Z" },
				]}
				reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
			/>,
		);
		expect(html).toContain("Review loop");
		expect(html).toContain("PR #42");
		expect(html).not.toContain("Fixed the review finding.");
		expect(html).toContain("Please also update the empty state.");
		expect(html).not.toContain("Review outcome");
		expect(html).not.toContain("Ready to merge");
	});

	test("shows a passed state on the final settled review loop", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={[
					{ id: "review", type: "user", content: "[GitHub] <!--os:review-handoff-->\n🔍 This session's PR #42 was just reviewed and is not merge-ready.", timestamp: "2026-08-12T12:00:00Z" },
					{ id: "fix", type: "assistant", content: "Fixed the review finding.", timestamp: "2026-08-12T12:01:00Z" },
				]}
				reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
			/>,
		);
		expect(html).toContain('aria-label="Review loop, Ready to merge, PR #42"');
		expect(html).toContain("Review loop");
		expect(html).toContain("Ready to merge");
		expect(html).not.toContain("5/5");
		expect(html).not.toContain("8 checks passed");
		expect(html).not.toContain("border-l border-line pl-3");
	});

	test("keeps the verdict when a legacy user-shaped status notice follows", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={[
					{ id: "review", type: "user", content: "[GitHub] <!--os:review-handoff-->\nReview PR #42", timestamp: "2026-08-12T12:00:00Z" },
					{ id: "fix", type: "assistant", content: "Fixed the review finding.", timestamp: "2026-08-12T12:01:00Z" },
					{ id: "deploy", type: "user", content: "[GitHub] Deployment finished for PR #42.", timestamp: "2026-08-12T12:02:00Z" },
				]}
				reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
			/>,
		);

		expect(html).toContain('aria-label="Review loop, Ready to merge, PR #42"');
		expect(html).toContain("Ready to merge");
	});

	test("opens to icon-led review steps and a final checked result", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				reviewLoopsOpen
				entries={[
					{ id: "review", type: "user", content: "[GitHub] <!--os:review-handoff-->\nReview PR #42", timestamp: "2026-08-12T12:00:00Z" },
					{ id: "read", type: "tool_use", toolUseId: "read-call", toolName: "Read", toolInput: { filePath: "/tmp/report.txt" }, content: "Using Read", timestamp: "2026-08-12T12:00:01Z" },
					{ id: "read-result", type: "tool_result", toolUseId: "read-call", content: "ok", timestamp: "2026-08-12T12:00:02Z" },
					{ id: "read2", type: "tool_use", toolUseId: "read-call-2", toolName: "Read", toolInput: { filePath: "/tmp/notes.txt" }, content: "Using Read", timestamp: "2026-08-12T12:00:03Z" },
					{ id: "read2-result", type: "tool_result", toolUseId: "read-call-2", content: "ok", timestamp: "2026-08-12T12:00:04Z" },
				]}
				reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
			/>,
		);
		expect(html).toContain('aria-expanded="true"');
		expect(html).toContain('data-tool-run="true"');
		expect(html).toContain(">2 steps<");
		expect(html).not.toContain("report.txt");
		expect(html).toContain('aria-label="Review passed"');
		expect(html).toContain("M4.75 12C4.75 7.99594");
		expect(html).toContain("M9.75 12.75L10.1837 13.6744");
		expect(html).toContain("text-faint");
		expect(html).toContain("1 round · 5/5 · 8 checks passed");
		expect(html).toContain("mt-0.5 pl-2");
		expect(html).toContain("flex size-[22px] flex-none self-center items-center justify-center");
		expect(html).toContain("-translate-y-px");
		expect(html).not.toContain(">Worked<");
	});

	test("shows progress while a loop is still fixing feedback", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				live
				entries={[
					{ id: "review", type: "user", content: "[GitHub] <!--os:review-handoff-->\n🔍 This session's PR #42 was just reviewed and is not merge-ready.", timestamp: "2026-08-12T12:00:00Z" },
					{ id: "fix", type: "assistant", content: "Fixing the review finding.", timestamp: "2026-08-12T12:01:00Z" },
				]}
				reviewResult={{ status: "passed", confidence: 5, checksPassed: 8 }}
			/>,
		);
		expect(html).toContain("Working");
		expect(html).toContain('aria-label="Review in progress"');
		expect(html).not.toContain('aria-label="Review passed"');
	});

	test("shows pending review facts without a running spinner after the worker settles", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={[
					{ id: "review", type: "user", content: "[GitHub] <!--os:review-handoff-->\nReview PR #42", timestamp: "2026-08-12T12:00:00Z" },
					{ id: "fix", type: "assistant", content: "Waiting for checks.", timestamp: "2026-08-12T12:01:00Z" },
				]}
				reviewResult={{ status: "pending", checksPassed: 7 }}
			/>,
		);
		expect(html).toContain("Working");
		expect(html).not.toContain('aria-label="Review in progress"');
	});

	test("shows a failed state when review findings remain", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks
				entries={[
					{ id: "review", type: "user", content: "[GitHub] <!--os:review-handoff-->\nReview PR #42", timestamp: "2026-08-12T12:00:00Z" },
					{ id: "fix", type: "assistant", content: "Could not resolve the finding.", timestamp: "2026-08-12T12:01:00Z" },
				]}
				reviewResult={{ status: "failed", confidence: 2, blocking: 1, checksFailed: 1 }}
			/>,
		);
		expect(html).toContain('aria-label="Review loop, Needs changes, PR #42"');
		expect(html).toContain("Needs changes");
		expect(html).not.toContain("1 blocking");
		expect(html).not.toContain("1 check failed");
	});
});

describe("TranscriptBlocks turn windowing", () => {
	// A review loop swallows the blocks it contains, so the rendered array is
	// shorter than the flat one. The trailing window has to be measured against
	// what is rendered, or the loops' absorbed rows come out of it.
	const windowed = (html: string) =>
		html.split("[content-visibility:auto]").length - 1;

	/** A review loop that swallows `absorbed` agent answers, then `tail` turns. */
	function transcriptWithReviewLoop(
		absorbed: number,
		tail: number,
	): TranscriptEntry[] {
		const at = (minute: number) =>
			`2026-08-12T${String(12 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00Z`;
		const built: TranscriptEntry[] = [
			{
				id: "handoff",
				type: "user",
				content: "[GitHub] <!--os:review-handoff-->\nReview PR #42",
				timestamp: at(0),
			},
		];
		// Absorbed by the loop: agent answers, none of them a human turn.
		for (let i = 0; i < absorbed; i++)
			built.push({
				id: `loop-answer-${i}`,
				type: "assistant",
				content: `Fixed finding ${i}.`,
				timestamp: at(1 + i),
			});
		// A human turn ends the loop, then ordinary exchanges after it.
		for (let i = 0; i < tail; i++)
			built.push({
				id: `tail-${i}`,
				type: i % 2 === 0 ? "user" : "assistant",
				content: `Tail message ${i}.`,
				timestamp: at(20 + i),
			});
		return built;
	}

	const windowedFor = (absorbed: number, tail: number) =>
		windowed(
			renderToStaticMarkup(
				<TranscriptBlocks entries={transcriptWithReviewLoop(absorbed, tail)} />,
			),
		);

	test("windows the same blocks however many a review loop absorbed", () => {
		// One loop plus the same tail either way, so the same rows render and the
		// same rows may be windowed. Measured against the flat array instead, a
		// loop that swallowed ten blocks took ten off the trailing window: 32 and
		// 24 windowed here rather than 21.
		expect(windowedFor(10, 30)).toBe(windowedFor(2, 30));
		expect(windowedFor(10, 30)).toBe(windowedFor(0, 30));
		expect(windowedFor(10, 30)).toBeGreaterThan(0);
	});

	test("windows nothing while the whole transcript fits the trailing window", () => {
		const html = renderToStaticMarkup(
			<TranscriptBlocks entries={transcriptWithReviewLoop(10, 12)} />,
		);
		expect(html).toContain('aria-label="Review loop, 1 round, PR #42"');
		expect(windowed(html)).toBe(0);
	});
});
