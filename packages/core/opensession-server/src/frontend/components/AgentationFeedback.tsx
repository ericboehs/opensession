import { lazy, Suspense } from "react";

import { useIsPhone } from "../hooks/useIsPhone";
import { isTouchPrimary } from "../lib/platform";

const Agentation = lazy(() =>
	import("agentation").then((module) => ({ default: module.Agentation })),
);

/** Visual page feedback for desktop clients. Agentation does not support touch. */
export function AgentationFeedback() {
	const isPhone = useIsPhone();
	if (isPhone || isTouchPrimary) return null;

	return (
		<Suspense fallback={null}>
			<Agentation />
		</Suspense>
	);
}
