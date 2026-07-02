/** Very short relative time ("now", "5m", "3h", "2d", then a date). Used by
 * message labels and sidebar workspace rows; pair with a tooltip/title carrying
 * the full local time. */
export function shortTime(ts: string): string {
	const d = new Date(ts);
	if (Number.isNaN(+d)) return "";
	const s = (Date.now() - +d) / 1000;
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
	return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Elapsed duration as a stopwatch: "0:07", "3:42", then "1:04:22" past an hour.
 * Used by the sidebar's live "in progress" ticker (how long a run's been going).
 */
export function elapsedClock(fromMs: number, nowMs: number = Date.now()): string {
	const total = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
