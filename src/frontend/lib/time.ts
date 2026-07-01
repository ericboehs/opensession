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
