import { motion, type HTMLMotionProps } from "motion/react";
import { cn } from "./cn";

/** Compact, non-interactive status lifted above the current surface. */
export function FloatingStatus({
	className,
	...props
}: HTMLMotionProps<"div">) {
	return (
		<motion.div
			className={cn(
				"flex items-center gap-2.5 whitespace-nowrap rounded-[999px] bg-popup-glass",
				"px-3.5 pt-2.5 pb-2 text-label font-medium leading-tight text-fg",
				"[backdrop-filter:var(--popup-blur)] [--smooth-ring-color:var(--popup-ring)] smooth-shadow-ring-sm",
				className,
			)}
			{...props}
		/>
	);
}
