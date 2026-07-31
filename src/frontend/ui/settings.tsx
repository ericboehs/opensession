import * as React from "react";
import { CardList } from "./card";
import { cn } from "./cn";

export function SettingsPanel({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("w-full max-w-[720px]", className)} {...props} />;
}

export function SettingsTitle({
	className,
	...props
}: React.ComponentPropsWithoutRef<"h1">) {
	return (
		<h1
			className={cn(
				"m-0 mb-5 px-2.5 text-page-title font-bold tracking-[-0.02em] text-fg [.settings-sheet_&]:hidden",
				className,
			)}
			{...props}
		/>
	);
}

export function SettingsDescription({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("px-2.5 text-supporting text-dim", className)} {...props} />;
}

export function SettingsGroupLabel({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn("mb-2 mt-[22px] px-2.5 text-label font-semibold text-faint", className)}
			{...props}
		/>
	);
}

export function SettingCard({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <CardList className={className} {...props} />;
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
	return <div className={cn("mt-2 px-2.5 text-meta text-faint", className)} {...props} />;
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

export function SettingsFormActions({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mt-1 flex justify-end gap-2", className)} {...props} />;
}
