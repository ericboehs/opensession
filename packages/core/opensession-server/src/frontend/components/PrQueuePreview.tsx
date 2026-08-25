import React, { } from "react";
import type { UnifiedSession, WSServerMessage } from "../lib/types";
import { PrPanel } from "./PrPanel";

interface Props {
	repo: string;
	branch: string;
	sessions: UnifiedSession[];
	onOpenSession: (id: string) => void;
	/** Open another PR in the review panel (stack map layer links). */
	onOpenPr?: (repo: string, branch: string) => void;
	send?: (msg: any) => void;
	addHandler?: (handler: (msg: WSServerMessage) => void) => () => void;
}

/**
 * Review-canvas adapter for PRs opened from the sidebar queue. A primary-branch
 * session uses the normal session APIs; an unclaimed PR uses the repo+branch
 * preview APIs, but both render the exact same review surface.
 */
export function PrQueuePreview({
	repo,
	branch,
	sessions,
	onOpenSession,
	onOpenPr,
	send,
	addHandler,
}: Props) {
	const session = ([...sessions]
				.filter(
					(item) =>
						item.repo === repo && item.branch === branch,
				)
				.sort((a, b) =>
					(b.lastActivity || "").localeCompare(a.lastActivity || ""),
				)[0] || null);

	return (
		<div className="h-full min-h-0 bg-surface">
			<PrPanel
				onOpenPr={onOpenPr}
				sessionId={session?.id || ""}
				previewTarget={session ? undefined : { repo, branch }}
				send={send}
				addHandler={addHandler}
				sessions={sessions}
				onOpenSessionById={onOpenSession}
				onOpenSession={
					session ? () => onOpenSession(session.id) : undefined
				}
				walkthrough={session?.walkthrough}
			/>
		</div>
	);
}
