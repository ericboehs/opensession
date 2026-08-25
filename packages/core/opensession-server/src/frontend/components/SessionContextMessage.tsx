import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BASE_PATH } from "../lib/base";
import {
	msgSystemInline,
	msgSystemRow,
} from "../lib/msg-classes";
import { Button } from "../ui/button";
import * as stylex from "@stylexjs/stylex";
import { type as typography } from "../styles/typography.stylex";
import { mergeStylexProps } from "../ui/cn";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	hAuto: {
			height: "auto"
	},
	minH0: {
			minHeight: "0"
	},
	cursorPointer: {
			cursor: "pointer"
	},
	bgTransparent: {
			backgroundColor: "transparent"
	},
	p0: {
			padding: "0"
	},
	FontFamilyInherit: {
			fontFamily: "inherit"
	},
	textInherit: {
			color: "inherit"
	},
	fontMedium: {
			fontWeight: "var(--font-weight-medium)"
	},
	textDim: {
			color: "var(--text-dim)"
	},
	mxAuto: {
			marginInline: "auto"
	},
	mt2: {
			marginTop: "8px"
	},
	wFull: {
			width: "100%"
	},
	maxW560px: {
			maxWidth: "560px"
	},
	roundedLg: {
			borderRadius: "calc(14px * var(--rf))"
	},
	bgPanel: {
			backgroundColor: "var(--bg-panel)"
	},
	px4: {
			paddingInline: "16px"
	},
	py3: {
			paddingBlock: "12px"
	},
	textLeft: {
			textAlign: "left"
	},
	m0: {
			margin: "0"
	},
	maxH70vh: {
			maxHeight: "70vh"
	},
	overflowAuto: {
			overflow: "auto"
	},
	whitespacePreWrap: {
			whiteSpace: "pre-wrap"
	},
	breakWords: {
			overflowWrap: "break-word"
	},
	fontSans: {
			fontFamily: "var(--sans)"
	},
	leadingRelaxed: {
			lineHeight: "var(--leading-relaxed)"
	},
	textFg: {
			color: "var(--text)"
	},
});

interface SessionContextMetadata {
	available: boolean;
	exact?: boolean;
	bytes?: number;
	estimatedTokens?: number;
	content?: string;
}

function sizeLabel(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

function tokenLabel(tokens: number): string {
	if (tokens >= 1000) return `~${Math.round(tokens / 1000)}k tokens`;
	return `~${tokens} tokens`;
}

/** The complete provider input that preceded the initial user message. The
 * body is fetched only after expansion, so making prompt bloat visible does
 * not add that bloat to every transcript load. */
export function SessionContextMessage({ sessionId }: { sessionId: string }) {
	const [metadata, setMetadata] = useState<SessionContextMetadata | null>(null);
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(false);
	const [content, setContent] = useState<string | null>(null);
	const rowRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const controller = new AbortController();
		setMetadata(null);
		setOpen(false);
		setContent(null);
		void fetch(
			`${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/session-context`,
			{ signal: controller.signal },
		)
			.then((response) => (response.ok ? response.json() : null))
			.then((value) => {
				if (value) setMetadata(value);
			})
			.catch(() => {});
		return () => controller.abort();
	}, [sessionId]);

	// Expanding a 100KB prompt can add most of a viewport above a transcript
	// pinned to its live edge. Keep the control and the start of the payload in
	// view so the first line does not jump above the phone's top bar.
	useLayoutEffect(() => {
		if (open && content != null)
			rowRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
	}, [open, content]);

	if (!metadata?.available) return null;
	const bytes = metadata.bytes ?? 0;
	const tokens = metadata.estimatedTokens ?? 0;
	const title = [
		metadata.exact === false ? "Session context · partial" : "Session context",
		sizeLabel(bytes),
		tokenLabel(tokens),
	].join(" · ");

	const toggle = async () => {
		if (open) {
			setOpen(false);
			return;
		}
		setOpen(true);
		if (content != null || loading) return;
		setLoading(true);
		await (async () => {
const response = await fetch(
				`${BASE_PATH}/api/sessions/${encodeURIComponent(sessionId)}/session-context?content=1`,
			);
			if (!response.ok) throw new Error("context request failed");
			const value = (await response.json()) as SessionContextMetadata;
			setContent(value.content ?? "");
})().catch(async () => {
setContent("Couldn’t load the session context.");
}).finally(async () => {
setLoading(false);
});
	};

	return (
		<div ref={rowRef} className={msgSystemRow} data-session-context>
			<span className={msgSystemInline}>
				<Button
					size="sm"
					variant="ghost"
					aria-expanded={open}
					onClick={toggle} {...mergeStylexProps("hover:bg-transparent", sx.hAuto, sx.minH0, sx.cursorPointer, sx.bgTransparent, sx.p0, sx.FontFamilyInherit, sx.textInherit)}
				>
					{title} ·{" "}
					<span {...stylex.props(sx.fontMedium, sx.textDim)}>
						{open ? "hide" : "show"}
					</span>
				</Button>
			</span>
			{open && (
				<div {...stylex.props(sx.mxAuto, sx.mt2, sx.wFull, sx.maxW560px, sx.roundedLg, sx.bgPanel, sx.px4, sx.py3, sx.textLeft)}>
					{loading ? (
						<p {...stylex.props(sx.m0, sx.textDim, typography.label)}>Loading…</p>
					) : (
						<pre {...stylex.props(sx.m0, sx.maxH70vh, sx.overflowAuto, sx.whitespacePreWrap, sx.breakWords, sx.fontSans, sx.leadingRelaxed, sx.textFg, typography.label)}>
							{content}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}
