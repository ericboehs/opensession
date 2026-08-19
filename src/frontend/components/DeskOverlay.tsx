import React, { useEffect, useRef, useState } from "react";
import { BASE_PATH } from "../lib/base";
import { getCurrentUser } from "./UserPicker";
import { DeskConversation } from "./DeskConversation";
import { DESK_SUGGESTIONS } from "../lib/desk-suggestions";
import { ResponsiveDialog } from "../ui/sheet";
import { IconDesk, IconExpand, IconMic, IconX } from "./icons";
import { Button } from "../ui/button";
import {
	DeskVoiceClient,
	type DeskVoiceState,
} from "../lib/desk-voice-client";
import { getDeskVoicePref, onDeskVoiceChanged } from "../lib/desk-voice-pref";

/**
 * The Desk — a summonable overlay (⌘J / the floating desk button) on top of
 * whatever you're doing. It is a standing concierge session for quick asks
 * and kicking off work without leaving the current view.
 *
 * Persistence is the point: after the first summon the body STAYS MOUNTED
 * (hidden, not unmounted) — the session's scoped socket keeps watching, so every
 * later ⌘J is instant with the transcript already in place. The desktop panel
 * uses the shared dialog's subtle scale transition when summoned.
 *
 * The Desk is a normal durable session (desk: true, hidden from the session
 * lists) pinned to a fast model+effort server-side; "Clear" sets a display
 * marker (server-stored) so the modal starts visually fresh while the full
 * transcript stays in the expanded session view.
 */

interface DeskOverlayProps {
	open: boolean;
	onClose: () => void;
	phone: boolean;
	/** Open the Desk session in the full viewer. */
	onOpenSession: (sessionId: string) => void;
}

function DeskBody({
	active,
	phone,
	onClose,
	onOpenSession,
}: Omit<DeskOverlayProps, "open"> & { active: boolean }) {
	const user = getCurrentUser();
	const [sessionId, setSessionId] = useState<string | null>(null);
	const [clearedAt, setClearedAt] = useState<string | undefined>(undefined);
	const [ensureError, setEnsureError] = useState<string | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);

	// Voice mode (Settings → Desk voice): a live GPT Realtime call layered on
	// this same Desk session. The call mirrors its transcript into the session,
	// so the conversation below updates live while you talk.
	const [voiceEnabled, setVoiceEnabled] = useState(getDeskVoicePref);
	const [voiceState, setVoiceState] = useState<DeskVoiceState>("idle");
	const [voiceError, setVoiceError] = useState<string | null>(null);
	const voiceRef = useRef<DeskVoiceClient | null>(null);
	useEffect(
		() => onDeskVoiceChanged(() => setVoiceEnabled(getDeskVoicePref())),
		[],
	);
	// Never leave a mic running past the overlay body's lifetime.
	useEffect(
		() => () => {
			voiceRef.current?.stop();
		},
		[],
	);

	const voiceActive = voiceState !== "idle" && voiceState !== "error";

	function toggleVoice() {
		if (voiceRef.current?.active) {
			voiceRef.current.stop();
			return;
		}
		setVoiceError(null);
		const client = new DeskVoiceClient({
			user,
			onState: (s, detail) => {
				setVoiceState(s);
				if (s === "error") setVoiceError(detail || "Voice call failed");
			},
		});
		voiceRef.current = client;
		void client.start().catch((e: any) => {
			setVoiceState("error");
			setVoiceError(e?.message || String(e));
		});
	}

	// One-time boot (the body stays mounted after the first summon): resolve
	// the standing Desk session + the clear marker.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`${BASE_PATH}/api/desk/ensure`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ user }),
				});
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const data = (await res.json()) as {
					sessionId: string;
					clearedAt: string | null;
				};
				if (cancelled) return;
				setSessionId(data.sessionId);
				if (data.clearedAt) setClearedAt(data.clearedAt);
			} catch (e: any) {
				if (!cancelled) setEnsureError(e?.message || "Failed to open the Desk");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [user]);

	// On summon: drop the caret straight into the composer (desktop — a phone
	// keyboard popping open unasked is hostile).
	useEffect(() => {
		if (!active || phone) return;
		const ta = rootRef.current?.querySelector("textarea");
		(ta as HTMLTextAreaElement | null)?.focus();
	}, [active, phone]);

	async function clearSession() {
		try {
			const res = await fetch(`${BASE_PATH}/api/desk/clear`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ user }),
			});
			const data = (await res.json()) as { clearedAt?: string };
			if (data.clearedAt) setClearedAt(data.clearedAt);
		} catch {}
	}

	return (
		// flex-1 rather than h-full: on phone the sheet's drag grabber is a
		// sibling above us, so we take the remainder instead of the whole panel.
		<div ref={rootRef} className="flex min-h-0 flex-1 flex-col">
			{/* Header */}
			<div className="flex shrink-0 items-center gap-2.5 border-b border-divider px-4 py-2.5">
				<IconDesk size={22} className="text-dim" />
				<span className="min-w-0 flex-1 truncate text-item-title font-semibold text-fg">
					Desk
				</span>
				{voiceEnabled && voiceState !== "idle" && (
					<span
						className="max-w-[160px] shrink-0 truncate text-meta font-medium text-dim"
						title={voiceError ?? undefined}
					>
						{voiceState === "error"
							? (voiceError ?? "Voice call failed")
							: { connecting: "Connecting…", listening: "Listening", thinking: "Thinking…", speaking: "Speaking", action: "Working…" }[voiceState]}
					</span>
				)}
				{voiceEnabled && (
					<Button
						variant="ghost"
						size="sm"
						className={`shrink-0 ${voiceActive ? "text-fg" : "text-faint"}`}
						icon={<IconMic size={20} />}
						onClick={toggleVoice}
						title={
							voiceActive
								? "End the voice call"
								: "Talk to your Desk (GPT Realtime)"
						}
						aria-label={voiceActive ? "End voice call" : "Start voice call"}
					/>
				)}
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0 text-faint"
					onClick={clearSession}
					title="Clear the session here. The full transcript stays in the expanded session."
				>
					Clear
				</Button>
				{sessionId && (
					<Button
						variant="ghost"
						size="sm"
						className="shrink-0 text-faint"
						icon={<IconExpand size={20} />}
						onClick={() => {
							onClose();
							onOpenSession(sessionId);
						}}
						title="Open as a full session"
						aria-label="Open as a full session"
					/>
				)}
				<Button
					variant="ghost"
					size="sm"
					className="shrink-0 text-faint"
					icon={<IconX size={20} />}
					onClick={onClose}
					aria-label="Close"
				/>
			</div>

			{/* Concierge session */}
			<div className="min-h-0 flex-1">
				{ensureError ? (
					<div className="px-4 py-6 text-center text-label font-medium text-dim">
						{ensureError}
					</div>
				) : sessionId ? (
					<DeskConversation
						sessionId={sessionId}
						presenceActive={active}
						effort="low"
						hideBefore={clearedAt}
						voiceSend={(text) =>
							voiceRef.current?.active
								? voiceRef.current.sendText(text)
								: false
						}
						// The Desk's job is delegating, so its transcript is full of
						// spawned workers. There's no side pane in a modal — open the
						// worker as a full session, the way the expand button does.
						onOpenSubagent={(id) => {
							onClose();
							onOpenSession(id);
						}}
						placeholder="Hand me something…"
						// Two hours: long enough that stepping away mid-thought keeps
						// the thread, short enough that yesterday's chat never owns the
						// surface you summoned for today's work.
						staleAfterMs={2 * 60 * 60 * 1000}
						suggestions={DESK_SUGGESTIONS}
					/>
				) : (
					<div className="px-4 py-6 text-center text-label font-medium text-dim">
						Opening…
					</div>
				)}
			</div>
		</div>
	);
}

export function DeskOverlay({
	open,
	onClose,
	phone,
	onOpenSession,
}: DeskOverlayProps) {
	return (
		<ResponsiveDialog
			open={open}
			onClose={onClose}
			phone={phone}
			label="Desk"
			// The body stays mounted after the first summon — see the module doc.
			keepMounted
			// bg-raised on both breakpoints, overriding the sheet's bg-surface:
			// the Desk's controls are recessed bg-surface inputs, which would
			// dissolve into a bg-surface panel.
			sheetClassName="h-[85dvh] bg-raised"
			modalClassName="h-[540px] max-h-[80vh] max-w-[560px]"
		>
			<DeskBody
				active={open}
				phone={phone}
				onClose={onClose}
				onOpenSession={onOpenSession}
			/>
		</ResponsiveDialog>
	);
}
