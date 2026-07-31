import * as React from "react";
import { Card, CardList } from "./card";
import { cn } from "./cn";

export function SettingsPanel({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("w-full max-w-[720px]", className)} {...props} />;
}

/**
 * A settings page's header: its title, an optional sentence of context, and
 * optional actions on the right. Every panel opens with one, so pages share a
 * top rhythm no matter who wrote them. The h1 hides inside the phone sheet,
 * which already names the section in its own nav bar.
 */
export function SettingsHeader({
	title,
	description,
	actions,
	className,
	...props
}: Omit<React.ComponentPropsWithoutRef<"header">, "title"> & {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
}) {
	return (
		<header
			className={cn("mb-5 flex items-start justify-between gap-4 px-4", className)}
			{...props}
		>
			<div className="min-w-0">
				<h1 className="m-0 text-page-title font-bold tracking-[-0.02em] text-fg [.settings-sheet_&]:hidden">
					{title}
				</h1>
				{description && (
					<p className="m-0 mt-1.5 text-supporting leading-relaxed text-dim [.settings-sheet_&]:mt-0">
						{description}
					</p>
				)}
			</div>
			{actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
		</header>
	);
}

export function SettingsGroupLabel({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn("mb-2 mt-6 px-4 text-label font-semibold text-faint", className)}
			{...props}
		/>
	);
}

/** The surface every settings group sits on: a soft fill, no border. The fill
 * alone separates a group from the page, so a page of settings reads as a few
 * quiet blocks rather than a stack of outlined boxes. */
const settingsSurface = "border-0 bg-raised";

export function SettingCard({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <CardList className={cn(settingsSurface, className)} {...props} />;
}

/** A section for content that isn't a list of rows — an editor, a picker, a
 * filter bar. Same surface SettingCard gives rows, so a page of prose sits in
 * the page's rhythm instead of floating on it. */
export function SettingsSection({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <Card className={cn(settingsSurface, "p-4", className)} {...props} />;
}

export function SettingRow({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("flex items-center gap-4 px-4 py-3.5", className)} {...props} />;
}

export function SettingRowText({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("min-w-0 flex-1", className)} {...props} />;
}

export function SettingRowTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("text-item-title font-medium text-fg", className)} {...props} />;
}

export function SettingRowDescription({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mt-0.5 text-supporting text-dim", className)} {...props} />;
}

export function SettingRowControl({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("shrink-0", className)} {...props} />;
}

export function SettingsHint({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mt-2 px-4 text-meta text-faint", className)} {...props} />;
}

export const settingsSelectClass =
	"cursor-pointer rounded-sm border border-line bg-raised px-2.5 py-1.5 text-control-label text-fg outline-none focus:border-accent disabled:cursor-default disabled:opacity-40";

export function SettingsForm({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn(
				"mb-3 flex flex-col gap-3.5 rounded-lg border border-line-strong bg-panel p-[18px]",
				className,
			)}
			{...props}
		/>
	);
}

export function SettingsFormTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mb-4 text-item-title font-semibold text-fg", className)} {...props} />;
}

export function SettingsFormRow({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("grid grid-cols-2 gap-3 max-sm:grid-cols-1", className)} {...props} />;
}

export function SettingsField({
	className,
	...props
}: React.ComponentPropsWithoutRef<"label">) {
	return (
		<label
			className={cn("mb-3 flex min-w-0 flex-col gap-1.5 text-label font-medium text-dim", className)}
			{...props}
		/>
	);
}

export const settingsInputClass =
	"w-full rounded-sm border border-line-strong bg-raised px-2.5 py-2 text-body text-fg outline-none placeholder:text-faint focus:border-accent";

/** Multi-line text entry inside settings — memory entries, the personal
 *  prompt. One class so every editor in settings reads the same. */
export const settingsTextareaClass =
	"w-full resize-y rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-body font-medium text-fg outline-none placeholder:text-faint focus:border-faint";

export function SettingsFormActions({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mt-1 flex justify-end gap-2", className)} {...props} />;
}
