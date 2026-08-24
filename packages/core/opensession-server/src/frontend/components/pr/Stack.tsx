import { useState } from "react";
import { linkPrStackApi } from "../../lib/api";
import type { PrDetails } from "../../lib/types";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { toast } from "../../ui/toast";

/**
 * The one stack state that cannot live in StackPopover yet: this session was
 * branched from another session, but GitHub has not linked the two PRs into a
 * stack. Once linked, PrPanel replaces this prompt with the compact stack chip
 * in its identity bar.
 */
export function StackLinkSection({
	pr,
	sessionId,
	onLinked,
}: {
	pr: PrDetails;
	sessionId?: string;
	onLinked: () => void;
}) {
	const [linking, setLinking] = useState(false);
	const [error, setError] = useState<string | null>(null);

	if (pr.stack || !pr.stackBase || !sessionId) return null;

	const link = async () => {
		setLinking(true);
		setError(null);
		try {
			await linkPrStackApi(sessionId);
			toast("Linked into a stack");
			onLinked();
		} catch (e: any) {
			setError(e?.message || "Couldn't link the stack");
		} finally {
			setLinking(false);
		}
	};

	return (
		<section className="flex shrink-0 items-center gap-3 px-6 py-3 phone:px-3">
			<div className="min-w-0 text-xs leading-relaxed text-dim">
				This branch was cut from <Badge variant="outline">{pr.stackBase}</Badge>,
				 but the PRs are not linked on GitHub yet.
			</div>
			<Button size="sm" onClick={link} disabled={linking}>
				{linking ? "Linking…" : "Link stack"}
			</Button>
			{error && <span className="text-xs text-red">{error}</span>}
		</section>
	);
}
