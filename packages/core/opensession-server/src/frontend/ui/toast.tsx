import { Toast as BaseToast } from "@base-ui/react/toast";
import { useEffect, useLayoutEffect, useRef } from "react";
import {
	IconArchive,
	IconArrowUp,
	IconBranches,
	IconCopy,
	IconLink,
	IconPlay,
	IconPlug,
	IconPlus,
	IconRestore,
	IconServer,
	IconTrash,
} from "../components/icons";
import { useIsPhone } from "../hooks/useIsPhone";
import {
	ONGOING_TOAST_POSITION,
	TOAST_NOTICE_LANE,
} from "../lib/notification-classes";
import { toastIconName, type ToastIconName } from "../lib/toast-icon";
import { AnimatedCheck } from "./copy";
import { Spinner } from "./spinner";
import { Tooltip } from "./tooltip";
import {
	clearUndoAction,
	isEditableUndoTarget,
	isUndoShortcut,
	registerUndoAction,
	UNDO_SHORTCUT_KEYS,
	undoLatestAction,
	type UndoHandle,
} from "../lib/undo";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps , mergeStylexClassName} from "./cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	my0: {
			marginBlock: "0"
	},
	minW0: {
			minWidth: "0"
	},
	focusRing: {
			":focus-visible": {
					outline: "2px solid var(--accent-ink)",
					outlineOffset: "2px"
			}
	},
	relative: {
			position: "relative"
	},
	My1: {
			marginBlock: "-4px"
	},
	ml1: {
			marginLeft: "4px"
	},
	shrink0: {
			flexShrink: "0"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	roundedMd: {
			borderRadius: "calc(7px * var(--rf))"
	},
	px2: {
			paddingInline: "8px"
	},
	py1: {
			paddingBlock: "4px"
	},
	fontSemibold: {
			fontWeight: "var(--font-weight-semibold)"
	},
	textAccent: {
			color: "var(--accent-ink)"
	},
	duration150: {
			transitionDuration: ".15s"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	grid: {
			display: "grid"
	},
	size35: {
			width: "14px",
			height: "14px"
	},
	placeItemsCenter: {
			placeItems: "center"
	},
	roundedFull: {
			borderRadius: "calc(infinity * 1px)"
	},
	pointerEventsNone: {
			pointerEvents: "none"
	},
	absolute: {
			position: "absolute"
	},
	insetX0: {
			insetInline: "0"
	},
	bottom0: {
			bottom: "0"
	},
	h05: {
			height: "2px"
	},
	originLeft: {
			transformOrigin: "0"
	},
	bgDim35: {
			backgroundColor: "var(--text-dim)"
	},
	fixed: {
			position: "fixed"
	},
	mxAuto: {
			marginInline: "auto"
	},
	hVarToastFrontmostHeight: {
			height: "var(--toast-frontmost-height)"
	},
	outlineNone: {
			outlineStyle: "none"
	},
	pointerEventsAuto: {
			pointerEvents: "auto"
	},
	left12: {
			left: "50%"
	},
	wMax: {
			width: "max-content"
	},
	maxWFull: {
			maxWidth: "100%"
	},
	duration200: {
			transitionDuration: ".2s"
	},
	flex: {
			display: "flex"
	},
	itemsCenter: {
			alignItems: "center"
	},
	gap2: {
			gap: "8px"
	},
	overflowHidden: {
			overflow: "hidden"
	},
	whitespaceNormal: {
			whiteSpace: "normal"
	},
	rounded999px: {
			borderRadius: "999px"
	},
	border: {
			borderStyle: "solid",
			borderWidth: "1px"
	},
	borderDividerSoft: {
			borderColor: "var(--divider-soft)"
	},
	bgPopup: {
			backgroundColor: "var(--popup-surface)"
	},
	py15: {
			paddingBlock: "6px"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	leadingTight: {
			lineHeight: "var(--leading-tight)"
	},
	textFg: {
			color: "var(--text)"
	},
	pl25: {
			paddingLeft: "10px"
	},
	pl3: {
			paddingLeft: "12px"
	},
	pr15: {
			paddingRight: "6px"
	},
	pr3: {
			paddingRight: "12px"
	},

	phoneWFull: {
		"@media (max-width: 720px)": {
			"width": "100%"
		}
	},
	phonePx3: {
		"@media (max-width: 720px)": {
			"paddingInline": "12px"
		}
	},
	phoneMaxWCalc100vw24px: {
		"@media (max-width: 720px)": {
			"maxWidth": "calc(100vw - 24px)"
		}
	},
	ZIndexCalc100VarToastIndex: {
		"zIndex": "calc(100 - var(--toast-index))"
	},
	TransformOriginCenterBottom: {
		"transformOrigin": "bottom"
	},
	TransformTranslateXCalc50VarToastSwipeMovementXTranslateYCalcVarToastSwipeMovementYVarToastIndex8pxScaleCalc1VarToastIndex004: {
		"transform": "translateX(calc(-50% + var(--toast-swipe-movement-x))) translateY(calc(var(--toast-swipe-movement-y) - var(--toast-index) * 8px)) scale(calc(1 - (var(--toast-index) * .04)))"
	},
	motionReduceTransitionOpacity: {
		"@media (prefers-reduced-motion: reduce)": {
			"transitionProperty": "opacity",
			"transitionTimingFunction": "var(--tw-ease,var(--ease))",
			"transitionDuration": "var(--tw-duration,var(--dur-micro))"
		}
	},
});

export type ToastVariant = "default" | "success" | "error";

/** One action beside a message. A toast that needs a choice is a dialog. */
export type ToastAction = {
	label: string;
	onClick: () => void;
};

export type ToastOptions = {
	variant?: ToastVariant;
	/** Defaults: 3200ms, 4200ms for errors, and 7000ms with an action. */
	duration?: number;
	/** Keeps live status visible until its owner dismisses it. */
	ongoing?: boolean;
	action?: ToastAction;
};

export type Toast = {
	id: number;
	message: string;
	variant: ToastVariant;
	ongoing?: boolean;
	action?: ToastAction;
};

type ToastData = {
	id: number;
	message: string;
	variant: ToastVariant;
	duration: number;
	ongoing?: boolean;
	action?: ToastAction;
};

const MAX_VISIBLE = 3;
const manager = BaseToast.createToastManager<ToastData>();
let toasts: Toast[] = [];
let nextId = 1;
const undoHandles = new Map<number, UndoHandle>();

function managerId(id: number) {
	return `opensession-toast-${id}`;
}

function inferVariant(message: string): ToastVariant {
	if (
		/\b(could not|couldn'?t|can not|can'?t|failed|failure|error|nothing|missed|lost|unavailable)\b|\bno\s|larger than|waiting for approval/i.test(
			message,
		)
	)
		return "error";
	if (
		/\b(copied|saved|done|created|sent|updated|added|removed|enabled|disabled|registered|connected|disconnected|linked|unlinked|archived|reopened|restored|forgotten|started|works|restarted|switched)\b/i.test(
			message,
		)
	)
		return "success";
	return "default";
}

function removeToastState(id: number) {
	toasts = toasts.filter((item) => item.id !== id);
	clearUndoAction(undoHandles.get(id));
	undoHandles.delete(id);
}

function runToastAction(id: number) {
	const item = toasts.find((candidate) => candidate.id === id);
	if (!item?.action) return;
	dismissToast(id);
	item.action.onClick();
}

/** Fire an app-wide toast. Returns its id so callers can close it early. */
export function toast(message: string, options: ToastOptions = {}): number {
	// Link controls already confirm the copy inline or through the platform share
	// surface. A second floating receipt repeats the same result in a louder place.
	if (/\blink copied\b/i.test(message)) return 0;

	const id = nextId++;
	const variant = options.variant ?? inferVariant(message);
	const item: Toast = {
		id,
		message,
		variant,
		ongoing: options.ongoing,
		action: options.action,
	};
	toasts = [...toasts, item];

	if (item.action?.label.toLowerCase() === "undo") {
		undoHandles.set(
			id,
			registerUndoAction(`toast:${id}`, () => runToastAction(id)),
		);
	}

	if (toasts.length > MAX_VISIBLE) {
		const overflow = toasts.slice(0, toasts.length - MAX_VISIBLE);
		for (const old of overflow) {
			removeToastState(old.id);
			manager.close(managerId(old.id));
		}
	}

	const duration =
		options.duration ??
		(options.ongoing
			? 0
			: options.action
				? 7000
				: variant === "error"
					? 4200
					: 3200);
	manager.add({
		id: managerId(id),
		description: message,
		type: variant,
		timeout: duration,
		data: { ...item, duration },
		onClose: () => removeToastState(id),
	});
	return id;
}

export function dismissToast(id: number) {
	removeToastState(id);
	manager.close(managerId(id));
}

/** The visible stack, exposed for store-level tests. */
export function activeToasts(): readonly Toast[] {
	return toasts;
}

/**
 * Base UI owns measurement, stacking, hover and focus expansion, timer pausing,
 * swipe dismissal, and accessibility. Keep one host mounted at the app root.
 */
export function ToastHost({ container }: { container?: HTMLElement | null }) {
	return (
		<BaseToast.Provider toastManager={manager} limit={MAX_VISIBLE}>
			<ToastViewport container={container} />
		</BaseToast.Provider>
	);
}

function ToastViewport({ container }: { container?: HTMLElement | null }) {
	const { toasts: items } = BaseToast.useToastManager<ToastData>();
	const isPhone = useIsPhone();
	const viewportRef = useRef<HTMLDivElement>(null);

	// Desktop aligns to the rendered composer rather than the window. Its centre
	// moves with the sidebar, workspace panel, and summary-card transform.
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || !container || isPhone) return;
		let composer: Element | null = null;
		let frame = 0;
		const resizeObserver = new ResizeObserver(() => scheduleAlign());
		const align = () => {
			frame = 0;
			const nextComposer = container.querySelector(".composer");
			if (nextComposer !== composer) {
				if (composer) resizeObserver.unobserve(composer);
				composer = nextComposer;
				if (composer) resizeObserver.observe(composer);
			}
			if (!composer) {
				viewport.style.left = "0px";
				viewport.style.right = "0px";
				return;
			}
			const containerRect = container.getBoundingClientRect();
			const composerRect = composer.getBoundingClientRect();
			const left = `${Math.max(0, Math.round(composerRect.left - containerRect.left))}px`;
			const right = `${Math.max(0, Math.round(containerRect.right - composerRect.right))}px`;
			if (viewport.style.left !== left) viewport.style.left = left;
			if (viewport.style.right !== right) viewport.style.right = right;
		};
		function scheduleAlign() {
			if (!frame) frame = requestAnimationFrame(align);
		}
		resizeObserver.observe(container);
		const mutationObserver = new MutationObserver((mutations) => {
			if (mutations.every(({ target }) => viewport.contains(target))) return;
			scheduleAlign();
		});
		mutationObserver.observe(container, {
			attributes: true,
			childList: true,
			subtree: true,
			attributeFilter: ["class", "style"],
		});
		window.addEventListener("resize", scheduleAlign);
		align();
		return () => {
			if (frame) cancelAnimationFrame(frame);
			resizeObserver.disconnect();
			mutationObserver.disconnect();
			window.removeEventListener("resize", scheduleAlign);
		};
	}, [container, isPhone, items.length]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (
				!isUndoShortcut(event) ||
				isEditableUndoTarget(event.target) ||
				!undoLatestAction()
			)
				return;
			event.preventDefault();
			// The archive fallback also listens on window. Only one reversible
			// action should consume this Command-Z.
			event.stopImmediatePropagation();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);

	return (
		<BaseToast.Portal container={container ?? undefined}>
			<BaseToast.Viewport
				ref={viewportRef}
				className={[TOAST_NOTICE_LANE, container ? "absolute" : "fixed", mergeStylexClassName("toast-viewport w-[min(480px,calc(100vw-32px))]", sx.mxAuto, sx.hVarToastFrontmostHeight, sx.outlineNone, sx.phoneWFull, sx.phonePx3)].filter(Boolean).join(" ")}
			>
				{items.map((item) => (
					<ToastCard key={item.id} toast={item} />
				))}
			</BaseToast.Viewport>
		</BaseToast.Portal>
	);
}

function ToastCard({ toast: item }: { toast: BaseToast.Root.ToastObject<ToastData> }) {
	const data = item.data;
	if (!data) return null;
	const iconName = toastIconName(data.message, data.variant);

	return (
		<BaseToast.Root
			toast={item}
			// Receipts rise above the composer at every width, so swiping down
			// follows the nearest screen edge. Live status is passive and stays
			// until the process that owns it dismisses it.
			swipeDirection={data.ongoing ? [] : ["down", "right"]}
			onClick={data.ongoing ? undefined : () => dismissToast(data.id)}
			className={[
				[data.ongoing ? "pointer-events-none" : "pointer-events-auto", mergeStylexClassName("", sx.absolute, sx.bottom0, sx.left12, sx.wMax, sx.maxWFull, sx.outlineNone, sx.phoneMaxWCalc100vw24px)].filter(Boolean).join(" "),
				data.ongoing ? ONGOING_TOAST_POSITION : "",
				mergeStylexClassName("", sx.ZIndexCalc100VarToastIndex, sx.TransformOriginCenterBottom),
				mergeStylexClassName("", sx.TransformTranslateXCalc50VarToastSwipeMovementXTranslateYCalcVarToastSwipeMovementYVarToastIndex8pxScaleCalc1VarToastIndex004),
				"data-[expanded]:[transform:translateX(calc(-50%+var(--toast-swipe-movement-x)))_translateY(calc(var(--toast-swipe-movement-y)-var(--toast-offset-y)-var(--toast-index)*8px))_scale(1)]",
				mergeStylexClassName("transition-[transform,translate,scale,opacity] ease-[cubic-bezier(0.23,1,0.32,1)]", sx.duration200, sx.motionReduceTransitionOpacity),
				"data-[starting-style]:opacity-0 data-[starting-style]:[translate:0_8px] data-[starting-style]:[scale:0.96] data-[ending-style]:opacity-0 data-[ending-style]:[translate:0_8px] data-[ending-style]:[scale:0.96] data-[limited]:opacity-0 motion-reduce:data-[starting-style]:[translate:0_0] motion-reduce:data-[starting-style]:[scale:1] motion-reduce:data-[ending-style]:[translate:0_0] motion-reduce:data-[ending-style]:[scale:1]",
			].join(" ")}
		>
			<BaseToast.Content
				className={[
					mergeStylexClassName("", sx.relative, sx.flex, sx.maxWFull, sx.itemsCenter, sx.gap2, sx.overflowHidden, sx.whitespaceNormal, sx.rounded999px, sx.border, sx.borderDividerSoft, sx.bgPopup),
					mergeStylexClassName("smooth-shadow-md", sx.py15, typography.supporting, sx.fontMedium, sx.leadingTight, sx.textFg),
					iconName ? mergeStylexClassName("", sx.pl25) : mergeStylexClassName("", sx.pl3),
					data.action ? mergeStylexClassName("", sx.pr15) : mergeStylexClassName("", sx.pr3),
				].join(" ")}
			>
				<ToastStatusIcon name={iconName} ongoing={data.ongoing} />
				{/* Description renders a <p>; remove its browser margins so the
				    visible height comes from the pill padding alone. */}
				<BaseToast.Description {...mergeStylexProps("line-clamp-2", sx.my0, sx.minW0)}
					title={data.message}
				>
					{data.message}
				</BaseToast.Description>
				{data.action && (
					<Tooltip label="Undo" shortcut={UNDO_SHORTCUT_KEYS}>
						<BaseToast.Action
							onClick={(event) => {
								event.stopPropagation();
								runToastAction(data.id);
							}} {...mergeStylexProps("transition-[background-color,transform] hover:bg-hover active:scale-[0.96] phone:-my-1.5 phone:ml-0.5 phone:grid phone:min-h-7 phone:place-items-center phone:rounded-[999px] phone:px-2.5 phone:after:absolute phone:after:inset-x-0 phone:after:top-1/2 phone:after:h-11 phone:after:-translate-y-1/2 phone:after:content-['']", sx.focusRing, sx.relative, sx.My1, sx.ml1, sx.shrink0, sx.cursorPointer, sx.roundedMd, sx.px2, sx.py1, sx.fontSemibold, sx.textAccent, sx.duration150, typography.supporting)}
						>
							{data.action.label}
						</BaseToast.Action>
					</Tooltip>
				)}
				{!data.ongoing && data.duration > 0 && (
					<ToastProgress duration={data.duration} />
				)}
			</BaseToast.Content>
		</BaseToast.Root>
	);
}

function ToastStatusIcon({
	name,
	ongoing,
}: {
	name: ToastIconName | null;
	ongoing?: boolean;
}) {
	const className = "shrink-0 text-dim";
	if (ongoing) return <Spinner {...stylex.props(sx.textDim)} />;

	switch (name) {
		case "archive":
			return <IconArchive size={14} className={className} aria-hidden />;
		case "branches":
			return <IconBranches size={14} className={className} aria-hidden />;
		case "check":
			return <AnimatedCheck size={14} className={className} />;
		case "copy":
			return <IconCopy size={14} className={className} aria-hidden />;
		case "link":
			return <IconLink size={14} className={className} aria-hidden />;
		case "play":
			return <IconPlay size={14} className={className} aria-hidden />;
		case "plug":
			return <IconPlug size={14} className={className} aria-hidden />;
		case "plus":
			return <IconPlus size={14} className={className} aria-hidden />;
		case "restore":
			return <IconRestore size={14} className={className} aria-hidden />;
		case "send":
			return <IconArrowUp size={14} className={className} aria-hidden />;
		case "server":
			return <IconServer size={14} className={className} aria-hidden />;
		case "trash":
			return <IconTrash size={14} className={className} aria-hidden />;
		case "error":
			return (
				<span
					aria-hidden
					{...stylex.props(sx.grid, sx.size35, sx.shrink0, sx.placeItemsCenter, sx.roundedFull, sx.fontSemibold, sx.textDim, typography.meta)}
				>
					!
				</span>
			);
		default:
			return null;
	}
}

/**
 * A visual timer that follows Base UI's pause rules. The store pauses expiry
 * while the stack is hovered, focused, or the tab is hidden; this line reads
 * the same viewport state and advances only while the timer can advance.
 */
function ToastProgress({ duration }: { duration: number }) {
	const lineRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		const line = lineRef.current;
		if (!line || duration <= 0) return;
		let elapsed = 0;
		let previous = performance.now();
		let frame = 0;

		const resetClock = () => {
			previous = performance.now();
		};
		const draw = (now: number) => {
			const viewport = line.closest(".toast-viewport");
			const paused =
				document.visibilityState !== "visible" ||
				viewport?.hasAttribute("data-expanded");
			if (!paused) elapsed += now - previous;
			previous = now;
			line.style.transform = `scaleX(${Math.max(0, 1 - elapsed / duration)})`;
			if (elapsed < duration) frame = requestAnimationFrame(draw);
		};

		document.addEventListener("visibilitychange", resetClock);
		frame = requestAnimationFrame(draw);
		return () => {
			document.removeEventListener("visibilitychange", resetClock);
			cancelAnimationFrame(frame);
		};
	}, [duration]);

	return (
		<span
			ref={lineRef}
			aria-hidden
			{...stylex.props(sx.pointerEventsNone, sx.absolute, sx.insetX0, sx.bottom0, sx.h05, sx.originLeft, sx.bgDim35)}
		/>
	);
}
