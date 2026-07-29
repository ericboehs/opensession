import React, { useEffect, useRef, useState } from "react";
import { useWebSocket } from "../hooks/useWebSocket";
import { clampSplitRatio } from "../lib/split-tabs";

type Socket = ReturnType<typeof useWebSocket>;

interface Props {
	leftId: string;
	rightId: string;
	focusedId: string;
	ratio: number;
	onFocus: (id: string) => void;
	onRatioChange: (ratio: number) => void;
	renderPane: (id: string, socket: Socket, focused: boolean) => React.ReactNode;
}

export function SessionSplit({
	leftId,
	rightId,
	focusedId,
	ratio,
	onFocus,
	onRatioChange,
	renderPane,
}: Props) {
	const leftSocket = useWebSocket();
	const rightSocket = useWebSocket();
	const rootRef = useRef<HTMLDivElement | null>(null);
	const stopResizeRef = useRef<(() => void) | null>(null);
	const [draftRatio, setDraftRatio] = useState(() => clampSplitRatio(ratio));

	useEffect(() => setDraftRatio(clampSplitRatio(ratio)), [ratio]);
	useEffect(
		() => () => {
			stopResizeRef.current?.();
			document.body.classList.remove("resizing-tab-split");
		},
		[],
	);

	function startResize(event: React.PointerEvent<HTMLDivElement>) {
		if (event.button !== 0) return;
		event.preventDefault();
		const root = rootRef.current;
		if (!root) return;
		stopResizeRef.current?.();
		document.body.classList.add("resizing-tab-split");
		const move = (moveEvent: PointerEvent) => {
			const rect = root.getBoundingClientRect();
			setDraftRatio(clampSplitRatio((moveEvent.clientX - rect.left) / rect.width));
		};
		const cleanup = () => {
			document.body.classList.remove("resizing-tab-split");
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", stop);
			window.removeEventListener("pointercancel", cancel);
			stopResizeRef.current = null;
		};
		const stop = (upEvent: PointerEvent) => {
			const rect = root.getBoundingClientRect();
			const next = clampSplitRatio((upEvent.clientX - rect.left) / rect.width);
			setDraftRatio(next);
			onRatioChange(next);
			cleanup();
		};
		const cancel = () => cleanup();
		stopResizeRef.current = cancel;
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", stop);
		window.addEventListener("pointercancel", cancel);
	}

	return (
		<div
			ref={rootRef}
			className="session-split"
			style={{ gridTemplateColumns: `${draftRatio * 100}% 8px minmax(0, 1fr)` }}
		>
			<div
				className={`session-split-pane ${focusedId === leftId ? "session-split-pane-focused" : ""}`}
				onPointerDownCapture={() => {
					if (focusedId !== leftId) onFocus(leftId);
				}}
			>
				{renderPane(leftId, leftSocket, focusedId === leftId)}
			</div>
			<div
				className="session-split-resize"
				role="separator"
				aria-orientation="vertical"
				aria-label="Resize split tabs"
				onPointerDown={startResize}
			/>
			<div
				className={`session-split-pane ${focusedId === rightId ? "session-split-pane-focused" : ""}`}
				onPointerDownCapture={() => {
					if (focusedId !== rightId) onFocus(rightId);
				}}
			>
				{renderPane(rightId, rightSocket, focusedId === rightId)}
			</div>
		</div>
	);
}
