import * as React from "react";
import { cn } from "./cn";
import { type as typography } from "../styles/typography.stylex";
import * as stylex from "@stylexjs/stylex";

/* Converted from Tailwind utilities; names mirror the original class tokens. */
const sx = stylex.create({
	mb22px: {
			marginBottom: "22px"
	},
	flex: {
			display: "flex"
	},
	itemsStart: {
			alignItems: "flex-start"
	},
	justifyBetween: {
			justifyContent: "space-between"
	},
	gap4: {
			gap: "16px"
	},
	m0: {
			margin: "0"
	},
	fontTitle: {
			fontWeight: "var(--title-weight)"
	},
	tracking001em: {
			letterSpacing: "-.01em"
	},
	textFg: {
			color: "var(--text)"
	},
	mt1: {
			marginTop: "4px"
	},
	textFaint: {
			color: "var(--text-faint)"
	},
});

export function PageHeader({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn("phone:flex-col phone:gap-2.5", className)} {...stylex.props(sx.mb22px, sx.flex, sx.itemsStart, sx.justifyBetween, sx.gap4)}
			{...props}
		/>
	);
}

export function PageTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"h2">) {
	return (
		<h2
			// The anchor for the iOS large-title handoff: while this heading is on
			// screen it is the page's name, and the chrome row above stays quiet;
			// once it has scrolled under that row, the row picks the name up. Read
			// by hooks/useLargeTitle.ts, which the app's top bar and the Analytics
			// range bar both call. Nothing else reads it, and it styles nothing.
			data-large-title=""
			className={cn(className)} {...stylex.props(sx.m0, typography.sectionTitle, sx.fontTitle, sx.tracking001em, sx.textFg)}
			{...props}
		/>
	);
}

export function PageDescription({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn(className)} {...stylex.props(sx.mt1, typography.supporting, sx.textFaint)} {...props} />;
}
