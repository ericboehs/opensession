import { duration, ease } from "../../ui/motion";

export const EMPTY_TAB_COLLAPSED_WIDTH = 32;

export const emptyTabTransition = {
	type: "tween" as const,
	duration: duration.base,
	ease,
};

/**
 * Finish the empty tab's reverse morph without keeping the live session around.
 * The visual copy can collapse after the real tab closes, so a pending create
 * response cannot race the animation and resurrect the deleted session.
 */
export function animateEmptyTabClose(button: HTMLButtonElement): void {
	const tab = button.closest<HTMLElement>('[role="tab"]');
	if (!tab) return;

	const rect = tab.getBoundingClientRect();
	const ghost = tab.cloneNode(true) as HTMLElement;
	ghost.removeAttribute("role");
	ghost.removeAttribute("aria-selected");
	ghost.setAttribute("aria-hidden", "true");
	Object.assign(ghost.style, {
		position: "fixed",
		left: `${rect.left}px`,
		top: `${rect.top}px`,
		width: `${rect.width}px`,
		height: `${rect.height}px`,
		overflow: "hidden",
		pointerEvents: "none",
		zIndex: "100",
		transition: "none",
	});
	document.body.append(ghost);

	const timing: KeyframeAnimationOptions = {
		duration: emptyTabTransition.duration * 1000,
		easing: `cubic-bezier(${ease.join(",")})`,
		fill: "forwards",
	};
	const animations = [
		ghost.animate(
			[
				{ width: `${rect.width}px` },
				{ width: `${EMPTY_TAB_COLLAPSED_WIDTH}px` },
			],
			timing,
		),
	];
	const title = ghost.querySelector<HTMLElement>(".session-tab-title")?.parentElement;
	if (title)
		animations.push(
			title.animate(
				[
					{ opacity: 1, filter: "blur(0px)" },
					{ opacity: 0, filter: "blur(4px)" },
				],
				timing,
			),
		);
	const glyph = ghost.querySelector<HTMLElement>(
		'button[aria-label="Close session"] > span',
	);
	if (glyph)
		animations.push(
			glyph.animate(
				[
					{ transform: "rotate(0deg) scale(1)" },
					{ transform: "rotate(45deg) scale(1.25)" },
				],
				timing,
			),
		);
	void Promise.allSettled(animations.map((animation) => animation.finished)).then(
		() => ghost.remove(),
	);
}
