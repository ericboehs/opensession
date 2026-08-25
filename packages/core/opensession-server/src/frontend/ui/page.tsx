import * as React from "react";
import { cn } from "./cn";
import { PageDescription, PageHeader, PageTitle } from "./page-header";

export type PageContentWidth = "narrow" | "default" | "wide" | "full";

const contentWidths: Record<PageContentWidth, string> = {
	narrow: "max-w-[760px]",
	default: "max-w-[860px]",
	wide: "max-w-[920px]",
	full: "max-w-none",
};

interface PageLayoutProps extends Omit<React.ComponentPropsWithoutRef<"div">, "title"> {
	title: React.ReactNode;
	description?: React.ReactNode;
	actions?: React.ReactNode;
	filters?: React.ReactNode;
	contentWidth?: PageContentWidth;
}

export function PageLayout({
	title,
	description,
	actions,
	filters,
	contentWidth = "default",
	className,
	children,
	...props
}: PageLayoutProps) {
	return (
		<div
			// The scroller the app's top bar watches, so it can reveal the compact
			// title once this page has travelled under it. Read by App.tsx through
			// hooks/useScrollEdge.ts; it styles nothing.
			data-page-scroll
			className={cn(
				"min-h-0 w-full flex-1 overflow-y-auto",
				className,
			)}
			{...props}
		>
			<div
				className={cn(
					"mx-auto w-full px-6 pb-[60px] pt-7 max-[560px]:px-3.5 max-[560px]:pb-12 max-[560px]:pt-[18px]",
					contentWidths[contentWidth],
				)}
			>
				<PageHeader>
					<div>
						<PageTitle>{title}</PageTitle>
						{description !== undefined && (
							<PageDescription>{description}</PageDescription>
						)}
					</div>
					{actions !== undefined && (
						<div className="phone:w-full">{actions}</div>
					)}
				</PageHeader>
				{filters !== undefined && (
					<div className="-mt-1.5 mb-[18px] flex flex-wrap items-center gap-2.5">
						{filters}
					</div>
				)}
				{children}
			</div>
		</div>
	);
}

interface PageSectionProps extends React.ComponentPropsWithoutRef<"div"> {
	contentWidth?: PageContentWidth;
}

export function PageSection({
	contentWidth = "default",
	className,
	...props
}: PageSectionProps) {
	return <div className={cn("mx-auto w-full", contentWidths[contentWidth], className)} {...props} />;
}
