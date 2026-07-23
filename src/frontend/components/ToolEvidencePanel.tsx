import type { TranscriptEntry } from "../lib/types";
import { resolveEntryImageSrc } from "../lib/osBlob";
import { toolDisplayName, toolSummary } from "./ToolCallBlock";

export interface ToolEvidence {
	entry: TranscriptEntry;
	result?: TranscriptEntry;
}

export function ToolEvidencePanel({
	evidence,
	sessionId,
	onOpenChanges,
	onOpenTerminal,
}: {
	evidence: ToolEvidence;
	sessionId?: string;
	onOpenChanges?: () => void;
	onOpenTerminal?: () => void;
}) {
	const { entry, result } = evidence;
	const name = entry.toolName || "Tool";
	const summary = toolSummary(name, entry.toolInput, entry.content);
	const hasInput = entry.toolInput !== undefined && entry.toolInput !== null;
	const input =
		typeof entry.toolInput === "string"
			? entry.toolInput
			: JSON.stringify(entry.toolInput, null, 2);

	return (
		<div className="mx-auto flex w-full max-w-[1000px] flex-col gap-4 p-4">
			<header className="border-b border-line pb-3">
				<div className="flex items-center gap-2">
					<h2 className="m-0 text-[13px] font-semibold text-fg">
						{toolDisplayName(name)}
					</h2>
					<span
						className={
							result?.isError
								? "rounded bg-red/10 px-1.5 py-0.5 text-[10px] text-red"
								: "rounded bg-green-soft px-1.5 py-0.5 text-[10px] text-green"
						}
					>
						{result?.isError ? "Failed" : result ? "Complete" : "Running"}
					</span>
				</div>
				<p className="mt-1 break-words font-mono text-[11.5px] text-dim">
					{summary}
				</p>
				<div className="mt-3 flex gap-2">
					{["Edit", "Write", "FileChange"].includes(name) && onOpenChanges ? (
						<button className="evidence-action" onClick={onOpenChanges}>
							Open changes
						</button>
					) : null}
					{name === "Bash" && onOpenTerminal ? (
						<button className="evidence-action" onClick={onOpenTerminal}>
							Open terminal
						</button>
					) : null}
				</div>
			</header>

			{hasInput ? (
				<section>
					<h3 className="evidence-label">Input</h3>
					<pre className="tool-pre max-h-[45vh] overflow-auto">{input}</pre>
				</section>
			) : null}

			{result?.content ? (
				<section>
					<h3 className="evidence-label">
						{result.isError ? "Error" : "Output"}
					</h3>
					<pre className="tool-pre max-h-[60vh] overflow-auto whitespace-pre-wrap">
						{result.content}
					</pre>
				</section>
			) : null}

			{result?.images?.map((raw, index) => {
				const src = resolveEntryImageSrc(raw, sessionId);
				return (
					<a key={index} href={src} target="_blank" rel="noreferrer">
						<img className="h-auto max-w-full rounded-lg border border-line" src={src} alt="" />
					</a>
				);
			})}
			{result?.videos?.map((src, index) => (
				<video
					key={index}
					className="w-full rounded-lg border border-line"
					src={src}
					controls
					playsInline
					preload="metadata"
				/>
			))}
		</div>
	);
}
