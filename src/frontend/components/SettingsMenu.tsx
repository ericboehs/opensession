import React, { useEffect, useRef, useState } from "react";

// The dropdown behind the "Michael" title in the top bar. It's a small menu whose
// one entry opens the full Settings page (theme, notifications, …). Appearance and
// other preferences live in Settings now, not inline here.

export function SettingsMenu({ onOpenSettings }: { onOpenSettings?: () => void }) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);

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
					<button
						className="settings-menu-item"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							onOpenSettings?.();
						}}
					>
						<svg width="14" height="14" viewBox="0 0 16 16" fill="none">
							<circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.4" />
							<path
								d="M8 1.5v1.6M8 12.9v1.6M14.5 8h-1.6M3.1 8H1.5M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1M12.6 12.6l-1.1-1.1M4.5 4.5L3.4 3.4"
								stroke="currentColor"
								strokeWidth="1.4"
								strokeLinecap="round"
							/>
						</svg>
						Settings
					</button>
				</div>
			)}
		</div>
	);
}
