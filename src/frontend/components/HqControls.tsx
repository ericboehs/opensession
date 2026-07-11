/**
 * HQ header controls, rendered only in an HQ session's header (session.hq):
 * the OPEN/CLOSED switch (the token tap — closed buffers events silently,
 * reopening flushes one catch-up digest) and the subscriptions popover
 * (per event type and per automation: Off / Digest / Now, plus digest
 * cadence and work hours that auto-flip the switch at the boundaries).
 */
import React, { useEffect, useRef, useState } from "react";
import {
	fetchHqInfo,
	updateHqConfig,
	type HqInfo,
	type HqLane,
} from "../lib/api";
import { Tooltip } from "../ui/tooltip";
import { IconChevronRight } from "./icons";

const LANES: { value: HqLane; label: string }[] = [
	{ value: "off", label: "Off" },
	{ value: "digest", label: "Digest" },
	{ value: "immediate", label: "Now" },
];

function LaneRow({
	label,
	value,
	onChange,
}: {
	label: string;
	value: HqLane;
	onChange: (v: HqLane) => void;
}) {
	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				padding: "3px 0",
				fontSize: 12,
			}}
		>
			<span
				style={{
					overflow: "hidden",
					textOverflow: "ellipsis",
					whiteSpace: "nowrap",
				}}
				title={label}
			>
				{label}
			</span>
			<span style={{ display: "flex", gap: 2, flexShrink: 0 }}>
				{LANES.map((l) => (
					<button
						key={l.value}
						type="button"
						onClick={() => onChange(l.value)}
						style={{
							padding: "2px 7px",
							borderRadius: 5,
							border: "1px solid var(--line)",
							background: value === l.value ? "var(--green)" : "transparent",
							color: value === l.value ? "#fff" : "var(--text-dim)",
							cursor: "pointer",
							fontSize: 11,
						}}
					>
						{l.label}
					</button>
				))}
			</span>
		</div>
	);
}

/**
 * The OPEN/CLOSED toggle as a self-contained chip — rendered beside the HQ
 * row in the sidebar and inside HqControls. Span-based (role=button) so it
 * can sit inside clickable rows without nesting <button>s. Instances sync
 * through the "backstage:hq-changed" window event. Renders nothing until the
 * user has an HQ config entry (i.e. has opened HQ once).
 */
export function HqStatusChip({ user }: { user: string }) {
	const [state, setState] = useState<{
		status: "open" | "closed";
		buffered: number;
	} | null>(null);

	useEffect(() => {
		let alive = true;
		const refetch = () =>
			fetchHqInfo(user)
				.then(
					(i) =>
						alive &&
						setState({ status: i.config.status, buffered: i.buffered }),
				)
				.catch(() => {});
		refetch();
		window.addEventListener("backstage:hq-changed", refetch);
		return () => {
			alive = false;
			window.removeEventListener("backstage:hq-changed", refetch);
		};
	}, [user]);

	if (!state) return null;
	const isOpen = state.status === "open";
	return (
		<Tooltip
			label={
				isOpen
					? "HQ is receiving events — click to close (events buffer silently)"
					: `HQ is closed${state.buffered ? ` — ${state.buffered} event(s) buffered` : ""} — click to open (flushes a catch-up digest)`
			}
		>
			<span
				role="button"
				tabIndex={0}
				className="source-chip"
				style={{
					cursor: "pointer",
					background: isOpen ? "var(--green)" : "transparent",
					color: isOpen ? "#fff" : "var(--text-dim)",
					border: isOpen
						? "1px solid var(--green)"
						: "1px solid var(--line)",
				}}
				onClick={(e) => {
					e.stopPropagation();
					const next = isOpen ? ("closed" as const) : ("open" as const);
					setState({ ...state, status: next });
					// Both outcomes broadcast: success syncs every instance, failure
					// makes them (and us) refetch the truth.
					updateHqConfig(user, { status: next })
						.catch(() => {})
						.finally(() =>
							window.dispatchEvent(new Event("backstage:hq-changed")),
						);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						e.stopPropagation();
						(e.currentTarget as HTMLElement).click();
					}
				}}
			>
				{isOpen
					? "OPEN"
					: state.buffered
						? `CLOSED · ${state.buffered}`
						: "CLOSED"}
			</span>
		</Tooltip>
	);
}

export function HqControls({
	user,
	variant = "header",
}: {
	user: string;
	/** "header" = chip + gear popover (desktop title row); "page" = the same
	 *  controls inline, for the phone session-info page where the title row —
	 *  and thus the header variant — is CSS-hidden. */
	variant?: "header" | "page";
}) {
	const [info, setInfo] = useState<HqInfo | null>(null);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	// Local drafts so a half-entered work-hours pair isn't PUT until complete.
	const [whOpen, setWhOpen] = useState("");
	const [whClose, setWhClose] = useState("");

	useEffect(() => {
		let alive = true;
		const refetch = () =>
			fetchHqInfo(user)
				.then((i) => alive && setInfo(i))
				.catch(() => {});
		refetch();
		// The status chip (here, or in the sidebar) saved a change — stay in sync.
		window.addEventListener("backstage:hq-changed", refetch);
		return () => {
			alive = false;
			window.removeEventListener("backstage:hq-changed", refetch);
		};
	}, [user]);

	useEffect(() => {
		setWhOpen(info?.config.workHours?.open ?? "");
		setWhClose(info?.config.workHours?.close ?? "");
	}, [info?.config.workHours?.open, info?.config.workHours?.close]);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node))
				setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [open]);

	if (!info) return null;
	const { config } = info;

	function patch(p: Parameters<typeof updateHqConfig>[1]) {
		setInfo(
			(cur) =>
				cur && {
					...cur,
					config: {
						...cur.config,
						...p,
						subs: { ...cur.config.subs, ...(p.subs || {}) },
					} as HqInfo["config"],
				},
		);
		updateHqConfig(user, p)
			.then((r) => {
				setInfo((cur) => cur && { ...cur, ...r });
				// Keep the sidebar chip (and any other instance) in sync.
				window.dispatchEvent(new Event("backstage:hq-changed"));
			})
			.catch(() => {});
	}

	function commitWorkHours(o: string, c: string) {
		if (o && c)
			patch({
				workHours: {
					open: o,
					close: c,
					tzOffsetMinutes: new Date().getTimezoneOffset(),
				},
			});
	}

	const switchButton = <HqStatusChip user={user} />;

	const settingsBody = (
		<>
					<div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
						Events
					</div>
					{info.eventTypes.map((t) => (
						<LaneRow
							key={t.key}
							label={t.label}
							value={config.subs[t.key] ?? t.dflt}
							onChange={(v) => patch({ subs: { [t.key]: v } })}
						/>
					))}
					{info.automations.length > 0 && (
						<div
							style={{
								fontWeight: 600,
								fontSize: 12,
								margin: "10px 0 4px",
							}}
						>
							Automation runs (off by default)
						</div>
					)}
					{info.automations.map((a) => (
						<LaneRow
							key={a.id}
							label={a.name}
							value={config.subs[`automation:${a.id}`] ?? "off"}
							onChange={(v) => patch({ subs: { [`automation:${a.id}`]: v } })}
						/>
					))}
					<div
						style={{
							display: "flex",
							alignItems: "center",
							justifyContent: "space-between",
							gap: 8,
							marginTop: 10,
							fontSize: 12,
						}}
					>
						<span>Digest every</span>
						<select
							value={config.digestMinutes}
							onChange={(e) =>
								patch({ digestMinutes: Number(e.target.value) })
							}
						>
							{[15, 30, 60, 120].map((m) => (
								<option key={m} value={m}>
									{m} min
								</option>
							))}
						</select>
					</div>
					<div
						style={{
							display: "flex",
							alignItems: "center",
							gap: 6,
							marginTop: 8,
							fontSize: 12,
						}}
					>
						<span style={{ flexShrink: 0 }}>Work hours</span>
						<input
							type="time"
							value={whOpen}
							onChange={(e) => {
								setWhOpen(e.target.value);
								commitWorkHours(e.target.value, whClose);
							}}
						/>
						<span>–</span>
						<input
							type="time"
							value={whClose}
							onChange={(e) => {
								setWhClose(e.target.value);
								commitWorkHours(whOpen, e.target.value);
							}}
						/>
						{config.workHours && (
							<button
								type="button"
								style={{
									border: "none",
									background: "transparent",
									color: "var(--text-dim)",
									cursor: "pointer",
								}}
								title="Clear work hours (manual switch only)"
								onClick={() => patch({ workHours: null })}
							>
								✕
							</button>
						)}
					</div>
					<div
						style={{
							marginTop: 8,
							fontSize: 11,
							color: "var(--text-dim)",
							lineHeight: 1.4,
						}}
					>
						Work hours auto-open/close HQ at the boundaries; the manual
						switch wins in between. Closed = events buffer silently.
					</div>
		</>
	);

	// Phone session-info page: the header title row (and so the header variant)
	// is CSS-hidden on phones, so render the switch + settings inline as a
	// section of the info page instead of behind a popover.
	if (variant === "page")
		return (
			<div style={{ padding: "2px 6px" }}>
				<button
					type="button"
					onClick={() => setOpen((o) => !o)}
					aria-expanded={open}
					style={{
						display: "flex",
						alignItems: "center",
						gap: 8,
						width: "100%",
						padding: "9px 8px",
						background: "transparent",
						border: "none",
						color: "inherit",
						fontSize: 13,
						cursor: "pointer",
					}}
				>
					<span style={{ fontWeight: 600 }}>HQ events</span>
					<span style={{ marginLeft: "auto", display: "flex" }}>
						{switchButton}
					</span>
					<IconChevronRight
						size={16}
						style={{
							color: "var(--text-dim)",
							transform: open ? "rotate(90deg)" : "none",
							transition: "transform 0.15s ease",
						}}
					/>
				</button>
				{open && <div style={{ padding: "0 8px 10px" }}>{settingsBody}</div>}
			</div>
		);

	return (
		<div
			ref={ref}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 6,
				position: "relative",
			}}
		>
			{switchButton}
			<Tooltip label="HQ events & work hours">
				<button
					type="button"
					className="viewer-newtab-btn"
					onClick={() => setOpen((o) => !o)}
					aria-label="HQ settings"
					aria-expanded={open}
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 16 16"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					>
						<circle cx="8" cy="8" r="2.2" />
						<path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M12.4 3.6L11 5M5 11l-1.4 1.4" />
					</svg>
				</button>
			</Tooltip>
			{open && (
				<div
					style={{
						position: "absolute",
						top: "calc(100% + 6px)",
						left: 0,
						zIndex: 50,
						width: 320,
						maxHeight: 440,
						overflowY: "auto",
						padding: 12,
						borderRadius: 8,
						border: "1px solid var(--line)",
						background: "var(--panel)",
						boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
					}}
				>
					{settingsBody}
				</div>
			)}
		</div>
	);
}
