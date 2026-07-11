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

export function HqControls({ user }: { user: string }) {
	const [info, setInfo] = useState<HqInfo | null>(null);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	// Local drafts so a half-entered work-hours pair isn't PUT until complete.
	const [whOpen, setWhOpen] = useState("");
	const [whClose, setWhClose] = useState("");

	useEffect(() => {
		let alive = true;
		fetchHqInfo(user)
			.then((i) => alive && setInfo(i))
			.catch(() => {});
		return () => {
			alive = false;
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
	const isOpen = config.status === "open";

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
			.then((r) => setInfo((cur) => cur && { ...cur, ...r }))
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
			<Tooltip
				label={
					isOpen
						? "HQ is receiving events — click to close (events buffer silently)"
						: `HQ is closed${info.buffered ? ` — ${info.buffered} event(s) buffered` : ""} — click to open (flushes a catch-up digest)`
				}
			>
				<button
					type="button"
					className="source-chip"
					style={{
						cursor: "pointer",
						background: isOpen ? "var(--green)" : "transparent",
						color: isOpen ? "#fff" : "var(--text-dim)",
						border: isOpen ? "1px solid var(--green)" : "1px solid var(--line)",
					}}
					onClick={() => patch({ status: isOpen ? "closed" : "open" })}
				>
					{isOpen
						? "OPEN"
						: info.buffered
							? `CLOSED · ${info.buffered}`
							: "CLOSED"}
				</button>
			</Tooltip>
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
				</div>
			)}
		</div>
	);
}
