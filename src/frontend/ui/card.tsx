import * as React from "react";
import { cn } from "./cn";

type CardElement = "article" | "div" | "section" | "ul";

type CardProps = React.HTMLAttributes<HTMLElement> & {
	as?: CardElement;
};

export function Card({ as: Component = "div", className, ...props }: CardProps) {
	return React.createElement(Component, {
		...props,
		className: cn("rounded-lg border border-line bg-panel", className),
	});
}

export function CardList({ className, ...props }: CardProps) {
	return (
		<Card
			className={cn(
				"overflow-hidden [&>*+*]:border-t [&>*+*]:border-line",
				className,
			)}
			{...props}
		/>
	);
}
