import type { CheckVisual } from "../lib/pr-checks";

export function CheckStatusIcon({ kind }: { kind: CheckVisual }) {
	if (kind === "pending")
		return (
			<span
				className="m-[1.5px] block size-[13px] animate-spin rounded-full border border-current/30 border-t-current"
				aria-hidden
			/>
		);
	if (kind === "success")
		return (
			<svg className="block size-4" viewBox="0 0 16 16" aria-hidden>
				<circle cx="8" cy="8" r="8" fill="currentColor" />
				<path
					d="M4.4 8.3l2.3 2.3 4.9-4.9"
					fill="none"
					stroke="#fff"
					strokeWidth="1.7"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			</svg>
		);
	if (kind === "failure")
		return (
			<svg className="block size-4" viewBox="0 0 16 16" aria-hidden>
				<circle cx="8" cy="8" r="8" fill="currentColor" />
				<path
					d="M5.4 5.4l5.2 5.2M10.6 5.4l-5.2 5.2"
					stroke="#fff"
					strokeWidth="1.7"
					strokeLinecap="round"
				/>
			</svg>
		);
	return (
		<svg className="block size-4" viewBox="0 0 16 16" aria-hidden>
			<circle
				cx="8"
				cy="8"
				r="7"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeDasharray="2.4 2.2"
			/>
		</svg>
	);
}
