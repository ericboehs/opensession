import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Class combiner for the ui/ layer: clsx for conditionals, tailwind-merge so
 * a caller's className can override a wrapper's defaults (`cn("px-2", className)`
 * with className="px-3" yields px-3, not both). Every ui/ component must pass
 * its className prop through this — a wrapper that swallows className forces
 * call sites to fork it.
 */
export function cn(...inputs: ClassValue[]): string {
	return twMerge(clsx(inputs));
}
