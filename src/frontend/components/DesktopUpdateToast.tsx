/**
 * Native-app update toast, docked bottom-right. Only renders inside the OS¹
 * mac shell (feature-detected via window.os1.updates, exposed by
 * os1-mac/src/preload.js): the shell's Squirrel updater reports "available"
 * (download already in progress) then "downloaded"; this surfaces both,
 * stays until dismissed, and offers a restart button once the update is
 * staged. Distinct from UpdatePill, which nudges about the *web* frontend
 * rebuilding — this one is about the shell binary itself.
 */

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { IconX } from "./icons";

type ShellUpdateState = {
	state: "idle" | "available" | "downloaded";
	version?: string | null;
};

type Os1Bridge = {
	updates?: {
		onState: (cb: (s: ShellUpdateState) => void) => (() => void) | void;
		install: () => void;
	};
};

function os1(): Os1Bridge | undefined {
	return (window as { os1?: Os1Bridge }).os1;
}

export function DesktopUpdateToast() {
	const [update, setUpdate] = useState<ShellUpdateState | null>(null);
	// Dismissal is keyed on state+version so waving away the "downloading"
	// toast still lets the "ready to restart" one come back.
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);

	useEffect(() => {
		const updates = os1()?.updates;
		if (!updates?.onState) return;
		const off = updates.onState((s) => setUpdate(s));
		return typeof off === "function" ? off : undefined;
	}, []);

	const active =
		update?.state === "available" || update?.state === "downloaded";
	const key = update ? `${update.state}:${update.version ?? ""}` : "";
	const show = Boolean(active && key !== dismissedKey);
	const downloaded = update?.state === "downloaded";

	return (
		<div className="pointer-events-none fixed bottom-6 right-6 z-[100] max-[720px]:bottom-[calc(84px+env(safe-area-inset-bottom))]">
			<AnimatePresence>
				{show && (
					<motion.div
						role="status"
						aria-live="polite"
						initial={{ opacity: 0, y: 14, scale: 0.94 }}
						animate={{ opacity: 1, y: 0, scale: 1 }}
						exit={{ opacity: 0, y: 8, scale: 0.96 }}
						transition={{ type: "spring", duration: 0.34, bounce: 0.22 }}
						className="pointer-events-auto flex w-72 items-start gap-3 rounded-lg border border-line-strong bg-panel px-3.5 py-3 text-sm text-fg shadow-[0_8px_24px_rgba(0,0,0,0.34)]"
					>
						<div className="min-w-0 flex-1">
							<div className="font-medium">
								{downloaded
									? `Update ready${update?.version ? ` — ${update.version}` : ""}`
									: "Update available"}
							</div>
							<div className="mt-0.5 leading-snug text-dim">
								{downloaded
									? "Restart OS¹ to finish installing."
									: "Downloading the new version of OS¹…"}
							</div>
							{downloaded && (
								<Button
									size="sm"
									className="mt-2.5"
									onClick={() => os1()?.updates?.install()}
								>
									Restart to update
								</Button>
							)}
						</div>
						<button
							aria-label="Dismiss"
							title="Dismiss"
							className="-mr-2 -mt-2 grid size-8 shrink-0 cursor-pointer place-items-center rounded-md text-dim hover:text-fg"
							onClick={() => setDismissedKey(key)}
						>
							<IconX size={20} />
						</button>
					</motion.div>
				)}
			</AnimatePresence>
		</div>
	);
}
