/**
 * Review requests for sessions of ALL sources: "please look at this" pointed at
 * a specific teammate, set from the session info panel's Reviewer picker. The
 * flagged session surfaces in a "Needs review" band at the top of the chosen
 * reviewer's sidebar (plus a push/alert), until the request is cleared.
 *
 * Same shape as the archive / title / status-override registries: a
 * backstage-owned JSON store keyed by unified session id, applied over every
 * session in getAllSessions. Slack/Linear session files are read-only for
 * backstage, so the request can't live in the session file.
 */
import { readFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { BACKSTAGE_CHATS_DIR } from "./paths";

export interface ReviewRequest {
	/** Reviewer's display name (the `backstage-user` value, e.g. "Kent"). */
	to: string;
	/** Who asked for the review. */
	by: string;
	/** ISO timestamp of the request. */
	at: string;
}

const REGISTRY_PATH = `${BACKSTAGE_CHATS_DIR}/review-requests.json`;

let cache: Record<string, ReviewRequest> | null = null;

function load(): Record<string, ReviewRequest> {
	if (cache) return cache;
	try {
		cache = existsSync(REGISTRY_PATH)
			? JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"))
			: {};
	} catch {
		cache = {};
	}
	return cache!;
}

function save(registry: Record<string, ReviewRequest>): void {
	cache = registry;
	writeJsonAtomic(REGISTRY_PATH, registry);
}

export function getReviewRequest(id: string): ReviewRequest | undefined {
	return load()[id];
}

/** Set (a reviewer) or clear (null) the review request for a session id. */
export function setReviewRequest(id: string, req: ReviewRequest | null): void {
	const registry = { ...load() };
	if (req) registry[id] = req;
	else delete registry[id];
	save(registry);
}
