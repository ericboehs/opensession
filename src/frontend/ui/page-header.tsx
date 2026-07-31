import * as React from "react";
import { cn } from "./cn";

export function PageHeader({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return (
		<div
			className={cn(
				"mb-[22px] flex items-start justify-between gap-4 max-[720px]:flex-col max-[720px]:gap-2.5",
				className,
			)}
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
			className={cn(
				"m-0 text-section-title font-semibold tracking-[-0.01em] text-fg",
				className,
			)}
			{...props}
		/>
	);
}

export function PageDescription({
	className,
	...props
}: React.ComponentPropsWithoutRef<"div">) {
	return <div className={cn("mt-1 text-supporting text-faint", className)} {...props} />;
}
