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

/** The real wall-clock time behind a message, written out: "Today at 14:32",
 * "Yesterday at 09:05", "Jul 12 at 14:32", "Jul 12, 2025 at 14:32". The locale
 * picks 12h/24h; no seconds — a transcript reads in minutes, and durations are
 * the TurnFooter's job. Used by hover reveals and timestamp tooltips.
 *
 * Absolute only, deliberately: these strings render inside memoized bubbles
 * with stable entry refs, so a relative part ("5m ago") would freeze at
 * whatever it was when the bubble last rendered. Only the day words go stale,
 * and only across midnight — the same tradeoff shortTime already makes. */
export function fullTime(ts: string, now: Date = new Date()): string {
	const d = new Date(ts);
	if (Number.isNaN(+d)) return "";
	const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	const midnight = (x: Date) =>
		new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const days = Math.round((midnight(now) - midnight(d)) / 86_400_000);
	if (days === 0) return `Today at ${time}`;
	if (days === 1) return `Yesterday at ${time}`;
	const date = d.toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
	});
	return `${date} at ${time}`;
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
