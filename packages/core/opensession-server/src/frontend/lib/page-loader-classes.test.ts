import { describe, expect, test } from "bun:test";
import {
	PAGE_LOADER_BAR,
	PAGE_LOADER_BARS,
	PAGE_LOADER_ROW,
} from "./page-loader-classes";

/**
 * Every failure mode this mark has is silent: it keeps rendering five bars and
 * simply stops moving, or moves as one block. None of that throws, and none of
 * it shows up in a snapshot of the markup, so it is asserted here instead.
 */
describe("page loader classes", () => {
	test("each bar carries its own literal delay, so the wave staggers", () => {
		const delays = PAGE_LOADER_BARS.map((bar) =>
			bar.match(/\[animation-delay:(\d+)ms\]/)?.[1],
		);
		expect(delays).toEqual(["0", "150", "300", "450", "600"]);
	});

	test("the arc is symmetric and tallest in the middle", () => {
		const heights = PAGE_LOADER_BARS.map((bar) => bar.match(/h-(\d+)/)?.[1]);
		expect(heights).toEqual(["2", "3", "4", "3", "2"]);
		// The row reserves exactly the tallest bar, so the mark has no dead space
		// to centre against a label with.
		expect(PAGE_LOADER_ROW).toContain("h-4");
	});

	test("the bars are capped with a true pill, not a squircle", () => {
		// base.css squircles every `rounded-*` class except `rounded-full`, and a
		// squircle at this radius leaves a 4px bar looking like a rectangle. This
		// is the one place in the app where opting out is the point, so it is
		// asserted rather than left to the next person to "fix" back.
		expect(PAGE_LOADER_BAR).toContain("rounded-full");
		expect(PAGE_LOADER_BAR).not.toContain("rounded-[999px]");
		expect(PAGE_LOADER_BAR).not.toContain("rounded-xs");
	});

	test("the animation is spelled as longhands, never the shorthand", () => {
		// `animate-[name_dur_…]` resets animation-delay, and whether it or the
		// per-bar delay wins depends on Tailwind's output order — which is how
		// every bar ends up breathing in unison.
		expect(PAGE_LOADER_BAR).not.toMatch(/\banimate-\[/);
		expect(PAGE_LOADER_BAR).toContain("[animation-name:page-loader-bar]");
		expect(PAGE_LOADER_BAR).toContain("[animation-duration:1s]");
		expect(PAGE_LOADER_BAR).toContain("[animation-iteration-count:infinite]");
	});

	test("it keeps breathing under prefers-reduced-motion", async () => {
		// base.css freezes animation wholesale under the preference; without an
		// element-level exception this loader silently stops, and a stopped
		// loader on an empty page reads as a hung app.
		expect(PAGE_LOADER_BAR).toContain(
			"motion-reduce:[animation-iteration-count:infinite]!",
		);
		expect(PAGE_LOADER_BAR).toContain("motion-reduce:[animation-duration:1.8s]!");
		// …but without the ripple: same phase on every bar.
		expect(PAGE_LOADER_BAR).toContain("motion-reduce:[animation-delay:0ms]!");
	});

	test("the keyframe it names is actually defined", async () => {
		const base = await Bun.file(
			new URL("../styles/base.css", import.meta.url).pathname,
		).text();
		expect(base).toContain("@keyframes page-loader-bar");
	});

	test("the launch splash still runs the same cadence", async () => {
		// The shell cannot import the bundle's CSS, so it carries its own copy of
		// this animation. The sizes differ on purpose; the timing must not.
		const shell = await Bun.file(
			new URL("../index.html", import.meta.url).pathname,
		).text();
		expect(shell).toContain("animation: splash-bar 1s ease-in-out infinite");
		for (const delay of ["0s", "0.15s", "0.3s", "0.45s", "0.6s"])
			expect(shell).toContain(`animation-delay: ${delay}`);
		expect(shell).toMatch(/@keyframes splash-bar\s*\{[^}]*scaleY\(0\.6\)/);
	});
});
