import { useSyncExternalStore } from "react";
import {
	deferredMergePhase,
	deferredMergesVersion,
	subscribeDeferredMerges,
	type DeferredMergePhase,
} from "../lib/deferred-merge";

/** Observe the shared five-second merge window for one pull request. */
export function useDeferredMergePhase(key: string | null): DeferredMergePhase {
	useSyncExternalStore(
		subscribeDeferredMerges,
		deferredMergesVersion,
		deferredMergesVersion,
	);
	return deferredMergePhase(key);
}
