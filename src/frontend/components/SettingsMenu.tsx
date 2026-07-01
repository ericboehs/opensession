import React, { useEffect, useRef, useState } from "react";
import {
	getThemePref,
	setThemePref,
	onThemeChanged,
	type ThemePref,
} from "../lib/theme";

// The dropdown behind the "Michael" title in the top bar. Scaffolded to grow:
// today it holds Appearance (theme), but each new preference is just another
// .settings-section. Kept deliberately small so it can live in the header.

function ThemeIcon({ pref }: { pref: ThemePref }) {
	if (pref === "light")
		return (
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.7" />
				<path
					d="M12 2.5v2.2M12 19.3v2.2M4.2 4.2l1.6 1.6M18.2 18.2l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.2 19.8l1.6-1.6M18.2 5.8l1.6-1.6"
					stroke="currentColor"
					strokeWidth="1.7"
					strokeLinecap="round"
				/>
			</svg>
		);
	if (pref === "dark")
		return (
			<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
				<path
					d="M20 14.2A8 8 0 1 1 9.8 4 6.3 6.3 0 0 0 20 14.2Z"
					stroke="currentColor"
					strokeWidth="1.7"
					strokeLinejoin="round"
				/>
			</svg>
		);
	return (
		<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
			<rect x="3" y="4.5" width="18" height="12" rx="1.6" stroke="currentColor" strokeWidth="1.7" />
			<path d="M8.5 20h7M12 16.5V20" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
		</svg>
	);
}

const THEME_OPTIONS: { value: ThemePref; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

export function SettingsMenu() {
	const [open, setOpen] = useState(false);
	const [pref, setPref] = useState<ThemePref>(getThemePref);
	const ref = useRef<HTMLDivElement | null>(null);

	// Reflect theme changes from anywhere (other tabs, OS flips in system mode).
	useEffect(() => onThemeChanged(() => setPref(getThemePref())), []);

	// Dismiss on outside click / Escape while open.
	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node))
				setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	function choose(value: ThemePref) {
		setThemePref(value);
		setPref(value);
	}

	return (
		<div className="settings-menu" ref={ref}>
			<button
				className={`settings-trigger ${open ? "active" : ""}`}
				onClick={() => setOpen((v) => !v)}
				aria-label="Settings"
				aria-haspopup="menu"
				aria-expanded={open}
			>
				<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
					<path
						d="M2 3.5L5 6.5L8 3.5"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			</button>
			{open && (
				<div className="settings-dropdown" role="menu">
					<div className="settings-section">
						<div className="settings-section-label">Appearance</div>
						<div
							className="settings-segmented"
							role="radiogroup"
							aria-label="Theme"
						>
							{THEME_OPTIONS.map((opt) => (
								<button
									key={opt.value}
									role="radio"
									aria-checked={pref === opt.value}
									className={`settings-seg ${pref === opt.value ? "active" : ""}`}
									onClick={() => choose(opt.value)}
								>
									<span className="settings-seg-icon">
										<ThemeIcon pref={opt.value} />
									</span>
									{opt.label}
								</button>
							))}
						</div>
						<div className="settings-hint">
							{pref === "system"
								? "Matches your operating system."
								: `Always ${pref} mode.`}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
