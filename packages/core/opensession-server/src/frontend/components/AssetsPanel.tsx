/**
 * Assets tab — the session's scratch folder of agent-produced artifacts
 * (HTML/JS visualizations, reports, diagrams, sample data; see
 * src/server/session-assets.ts). Split view: file tree on top, preview below.
 *
 * This is the place you go to sit with the folder. One file on its own arrives
 * over the conversation instead, in `AssetOverlay` — and both render the same
 * `AssetPreview` with the same action menu, while placing metadata where it
 * best fits each surface.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { fetchSessionAssets, type SessionAssetFile } from "../lib/api";
import type { WSServerMessage } from "../lib/types";
import type { NewSessionPrefill } from "../lib/new-session-link";
import { Button } from "../ui/button";
import { AssetActions, AssetPreview } from "./AssetView";
import { resolvedAssetPath } from "../lib/asset-preview";

/** Lives in SessionViewer (not the panel) so the tab button can show/hide on
 * the file count without the panel being mounted. */
export function useSessionAssets(
	sessionId: string,
	addHandler: (h: (msg: WSServerMessage) => void) => () => void,
) {
	const [files, setFiles] = useState<SessionAssetFile[]>([]);
	const refresh = useCallback(() => {
		fetchSessionAssets(sessionId)
			.then((r) => setFiles(r.files || []))
			.catch(() => {});
	}, [sessionId]);
	useEffect(() => {
		setFiles([]);
		refresh();
	}, [refresh]);
	useEffect(
		() =>
			addHandler((msg) => {
				if (msg.type === "assets_changed" && msg.sessionId === sessionId)
					refresh();
			}),
		[addHandler, sessionId, refresh],
	);
	return { files, refresh };
}

/** Every ancestor dir across the file set — small trees, keep them all open. */
function allDirs(paths: string[]): string[] {
	const dirs = new Set<string>();
	for (const p of paths) {
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++)
			dirs.add(parts.slice(0, i).join("/"));
	}
	return [...dirs];
}

function AssetsTree({
	paths,
	selected,
	onSelect,
}: {
	paths: string[];
	selected: string | null;
	onSelect: (path: string) => void;
}) {
	const onSelectRef = useRef(onSelect);
	onSelectRef.current = onSelect;
	const { model } = useFileTree({
		paths,
		initialExpandedPaths: allDirs(paths),
		initialSelectedPaths: selected ? [selected] : undefined,
		onSelectionChange: (sel) => {
			const p = sel[0] ? String(sel[0]) : null;
			// Directory rows also select — only react to real files.
			if (p && paths.includes(p)) onSelectRef.current(p);
		},
	});
	// Same forced dark color-scheme as the docs tree (Notes.tsx) — the tree's
	// own shadow styles use light-dark() and would otherwise follow the OS.
	return <FileTree model={model} className="block h-full [color-scheme:dark]" />;
}

export function AssetsPanel({
	sessionId,
	files,
	refresh,
	selectedPath = null,
	onSelectPath,
	onOpenNewSession,
}: {
	sessionId: string;
	files: SessionAssetFile[];
	refresh: () => void;
	/** Controlled selection — the file the overlay was promoted from. */
	selectedPath?: string | null;
	onSelectPath: (path: string | null) => void;
	onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
	const paths = useMemo(() => files.map((f) => f.path), [files]);
	const selected = useMemo(
		() => resolvedAssetPath(paths, selectedPath),
		[paths, selectedPath],
	);
	// Keep SessionViewer aligned with tree navigation. Without this, promoting
	// the same overlay twice can be a React no-op after the tree selected
	// another file in between.
	useEffect(() => {
		if (selected !== selectedPath) onSelectPath(selected);
	}, [selected, selectedPath, onSelectPath]);

	const file = files.find((f) => f.path === selected) || null;

	if (!files.length) {
		return (
			<div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
				<div className="text-label text-dim">No assets yet</div>
				<div className="max-w-[360px] text-label text-faint">
					Ask the agent to save a visualization, report, or demo page here.
					It writes files with opensession-assets' write_asset and they
					preview live in this tab.
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex max-h-[38%] min-h-[88px] flex-col overflow-hidden border-b border-line">
				<div className="flex items-center justify-between px-3 pt-2 pb-1">
					<span className="text-label font-semibold text-faint">
						Files · {files.length}
					</span>
					<Button
						variant="ghost"
						size="sm"
						className="text-faint"
						onClick={refresh}
						title="Refresh the file list"
					>
						Refresh
					</Button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1.5">
					<AssetsTree
						key={paths.join("\n")}
						paths={paths}
						selected={selected}
						onSelect={onSelectPath}
					/>
				</div>
			</div>
			{file ? (
				<>
					<AssetActions
						sessionId={sessionId}
						file={file}
						refresh={refresh}
						showSize
					/>
					<AssetPreview
						sessionId={sessionId}
						file={file}
						onOpenNewSession={onOpenNewSession}
					/>
				</>
			) : null}
		</div>
	);
}
