import { repoLabel } from "../lib/repo-label";
import { Tooltip } from "../ui/tooltip";
import { providerFromUrl } from "../lib/provider";
import {
	refChipText,
	refLabel,
	refState,
	refTone,
	type SessionPrRef,
} from "../lib/pr-refs";
import {
	prChipClass,
	PR_ROW,
	PR_ROW_BG,
	PR_ROW_MAIN,
	PR_ROW_OUT,
	PR_ROW_STATE,
	PR_ROW_TITLE,
	PR_STATE_TEXT,
} from "../lib/pr-tone-classes";
import { IconArrowUpRight } from "./icons";

/**
 * The PRs a session owns beyond the one its own branch carries, stacked under
 * the primary status strip — a feature shipped as four PRs gets four rows.
 *
 * Each row repeats the strip's anatomy one weight down: toned number chip on
 * the left where the primary's chip sits, title in the middle, toned state on
 * the right. That's the whole idea — the series should read as more of the same
 * status treatment, not as a second card stapled under the strip, so the rows
 * carry no surface of their own and take their colour from the parts that mean
 * something. Four chips crammed into the primary line was the first attempt and
 * it read as noise; a row each stays legible at four PRs.
 *
 * Kept out of PrStatusBar so the multi-PR presentation renders (and is tested)
 * without the strip's PR/git fetching.
 */

/** Ref-only, so no per-row Merge: the row opens that PR's Review tab, which has
 *  the real detail (checks, mergeability) merging needs. */
export function PrSeriesRow({
	prRef,
	primaryRepo,
	onOpen,
}: {
	prRef: SessionPrRef;
	/** The session's own repo — a PR inside it needs no repo hint on its chip. */
	primaryRepo?: string;
	onOpen?: (r: { repo: string; branch: string }) => void;
}) {
	const tone = refTone(prRef);
	const provider = providerFromUrl(prRef.url || "");
	return (
		<div className={`${PR_ROW} ${PR_ROW_BG[tone]}`} data-tone={tone}>
			<button
				type="button"
				className={PR_ROW_MAIN}
				onClick={() => onOpen?.({ repo: prRef.repo, branch: prRef.branch })}
				title={`${refLabel(prRef)} · open in the PR tab`}
				aria-label={`Review ${repoLabel(prRef.repo)} pull request #${prRef.number}`}
			>
				<span className={prChipClass(tone, "row")}>
					{refChipText(prRef, primaryRepo)}
				</span>
				{prRef.title && <span className={PR_ROW_TITLE}>{prRef.title}</span>}
				<span className={`${PR_ROW_STATE} ${PR_STATE_TEXT[tone]}`}>
					{refState(prRef)}
				</span>
			</button>
			{prRef.url && (
				<Tooltip label={`Open on ${provider.name}`}>
					<a
						className={PR_ROW_OUT}
						href={prRef.url}
						target="_blank"
						rel="noopener"
						aria-label={`Open ${repoLabel(prRef.repo)} pull request #${prRef.number} on ${provider.name}`}
					>
						<IconArrowUpRight size={16} />
					</a>
				</Tooltip>
			)}
		</div>
	);
}

export function PrSeriesRows({
	refs,
	primaryRepo,
	onOpen,
}: {
	refs: SessionPrRef[];
	primaryRepo?: string;
	onOpen?: (r: { repo: string; branch: string }) => void;
}) {
	if (refs.length === 0) return null;
	return (
		<>
			{refs.map((ref) => (
				<PrSeriesRow
					key={`${ref.repo} ${ref.branch}`}
					prRef={ref}
					primaryRepo={primaryRepo}
					onOpen={onOpen}
				/>
			))}
		</>
	);
}
