import { useEffect, useState } from "react";
import {
	fetchPreviewPool,
	fetchWarmTemplates,
	refreshPreviewPoolGolden,
	refreshWarmTemplateNow,
	updatePreviewPool,
	updateWarmTemplate,
	type PreviewPoolEntry,
	type WarmTemplateEntry,
} from "../../lib/api";
import { warmAgo } from "../../lib/time";
import { Button } from "../../ui/button";
import {
	SettingCard,
	SettingCardSkeleton,
	SettingsGroupLabel,
	SettingsHeader,
	SettingsHint,
	SettingsPanel,
} from "../../ui/settings";
import { InlineAlert } from "../../ui/state";
import { Switch } from "../../ui/switch";
import { Select, SettingRow } from "./shared";

// ── Warm previews (per-repo prebuilt template worktrees) ────────────────────

const WARM_INTERVAL_OPTIONS: { value: string; label: string }[] = [
	{ value: "1", label: "Every hour" },
	{ value: "3", label: "Every 3 hours" },
	{ value: "6", label: "Every 6 hours" },
	{ value: "12", label: "Every 12 hours" },
	{ value: "24", label: "Daily" },
];

function WarmPreviewsPanel() {
	const [repos, setRepos] = useState<WarmTemplateEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchWarmTemplates()
			.then((r) => alive && setRepos(r.repos))
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, []);

	// Poll while a refresh runs so the status line flips to "Warm at <sha>"
	// on its own.
	useEffect(() => {
		if (!repos?.some((e) => e.refreshing)) return;
		let alive = true;
		const t = setTimeout(() => {
			fetchWarmTemplates()
				.then((r) => alive && setRepos(r.repos))
				.catch(() => {});
		}, 5000);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [repos]);

	function apply(p: Promise<{ repos: WarmTemplateEntry[] }>) {
		p.then((r) => setRepos(r.repos)).catch((e) => setError(e.message));
	}

	const label = (
		<SettingsGroupLabel className="mt-0">Host dependency cache</SettingsGroupLabel>
	);

	if (!repos)
		return (
			<>
				{label}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					<SettingCardSkeleton rows={3} label="Loading repos" />
				)}
			</>
		);

	return (
		<>
			{label}

			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}

			<SettingCard>
				{repos.map((entry) => {
					const s = entry.state;
					const status = entry.refreshing
						? "Refreshing now, updating the dependency cache…"
						: !entry.enabled
							? "Off. Fresh worktrees install cold."
							: s?.ok
								? `Cached at ${s.sha} · refreshed ${warmAgo(s.refreshedAt)} · ${
										entry.spares
									} spare${entry.spares === 1 ? "" : "s"} ready`
								: s?.lastError
									? `Last refresh failed: ${s.lastError}`
									: "Enabled. First refresh runs shortly.";
					return (
						<SettingRow
							key={entry.repoId}
							title={entry.repoId}
							desc={status}
							control={
								<div className="flex items-center gap-2">
									{entry.enabled && (
										<>
											<Button
												size="sm"
												disabled={entry.refreshing}
												onClick={() =>
													apply(refreshWarmTemplateNow(entry.repoId))
												}
											>
												{entry.refreshing ? "Building…" : "Run now"}
											</Button>
											<Select
												label={`Refresh interval for ${entry.repoId}`}
												value={String(entry.intervalHours)}
												options={WARM_INTERVAL_OPTIONS}
												onChange={(v) =>
													apply(
														updateWarmTemplate(entry.repoId, {
															intervalHours: parseInt(v, 10),
														}),
													)
												}
											/>
										</>
									)}
									<Switch
										aria-label={`Warm deps for ${entry.repoId}`}
										checked={entry.enabled}
										onCheckedChange={(v) =>
											apply(updateWarmTemplate(entry.repoId, { enabled: v }))
										}
									/>
								</div>
							}
						/>
					);
				})}
			</SettingCard>
			<SettingsHint>
				Keeps a host-side worktree per repo with node_modules installed, refreshed
				from its default branch on a schedule. Host sessions adopt a ready copy
				instead of paying a cold install.
			</SettingsHint>
		</>
	);
}

// ── Preview pool: warm pre-booted dev-server containers per repo — the
// Preview button claims one instantly instead of paying a cold boot. ──

const POOL_COUNT_OPTIONS = [0, 1, 2, 3].map((n) => ({
	value: String(n),
	label: String(n),
}));

const POOL_BACKEND_OPTIONS = [
	{ value: "docker", label: "Docker (local)" },
	{ value: "daytona", label: "Daytona (remote)" },
	{ value: "microvm", label: "MicroVM (snapshots)" },
];

function PreviewPoolPanel() {
	const [repos, setRepos] = useState<PreviewPoolEntry[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		fetchPreviewPool()
			.then((r) => alive && setRepos(r.repos))
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
		};
	}, []);

	// Poll while a golden build runs (or containers are warming) so the
	// status line updates on its own.
	useEffect(() => {
		if (
			!repos?.some(
				(e) => e.goldenBuilding || e.containers.some((c) => c.state === "warming"),
			)
		)
			return;
		let alive = true;
		const t = setTimeout(() => {
			fetchPreviewPool()
				.then((r) => alive && setRepos(r.repos))
				.catch(() => {});
		}, 5000);
		return () => {
			alive = false;
			clearTimeout(t);
		};
	}, [repos]);

	function apply(p: Promise<{ repos: PreviewPoolEntry[] }>) {
		p.then((r) => setRepos(r.repos)).catch((e) => setError(e.message));
	}

	const label = <SettingsGroupLabel>Preview pool</SettingsGroupLabel>;

	if (!repos)
		return (
			<>
				{label}
				{error ? (
					<InlineAlert>{error}</InlineAlert>
				) : (
					<SettingCardSkeleton rows={3} label="Loading repos" />
				)}
			</>
		);

	return (
		<>
			{label}

			{error && <InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>}

			<SettingCard>
				{repos.map((entry) => {
					const counts = {
						ready: entry.containers.filter((c) => c.state === "ready").length,
						paused: entry.containers.filter((c) => c.state === "paused").length,
						warming: entry.containers.filter((c) => c.state === "warming")
							.length,
						claimed: entry.containers.filter((c) => c.state === "claimed")
							.length,
					};
					const poolBits = [
						counts.ready && `${counts.ready} ready`,
						counts.paused && `${counts.paused} paused`,
						counts.warming && `${counts.warming} warming`,
						counts.claimed && `${counts.claimed} in use`,
					]
						.filter(Boolean)
						.join(" · ");
					const status = entry.goldenBuilding
						? "Building the golden image: boots the dev server once, warms routes, commits (~10 min)…"
						: !entry.config.enabled
							? "Off. Previews boot cold on the host."
							: (entry.config.backend || "docker") === "daytona"
								? `Daytona sandboxes${poolBits ? ` · ${poolBits}` : " · pool provisioning (first sandbox takes ~10 min)…"}`
								: (entry.config.backend || "docker") === "microvm"
									? `Firecracker snapshots · claims restore in ~2s${poolBits ? ` · ${poolBits}` : " · restore-on-demand (no warm members needed)"}`
								: entry.golden?.sha
									? `Image at ${entry.golden.sha.slice(0, 10)} · built ${warmAgo(
											entry.golden.builtAt,
										)}${poolBits ? ` · ${poolBits}` : " · pool filling…"}${
											entry.golden.lastError
												? ` · last build failed: ${entry.golden.lastError.slice(0, 120)}`
												: ""
										}`
									: "Enabled. First golden image builds shortly.";
					return (
						<SettingRow
							key={entry.repoId}
							title={entry.repoId}
							desc={status}
							control={
								<div className="flex items-center gap-2">
									{entry.config.enabled && (
										<>
											<Select
												label={`Preview pool backend for ${entry.repoId}`}
												value={entry.config.backend || "docker"}
												options={POOL_BACKEND_OPTIONS}
												onChange={(v) =>
													apply(
														updatePreviewPool(entry.repoId, {
															backend: v as "docker" | "daytona" | "microvm",
														}),
													)
												}
											/>
											{(entry.config.backend || "docker") === "docker" && (
												<Button
													size="sm"
													disabled={entry.goldenBuilding}
													onClick={() =>
														apply(refreshPreviewPoolGolden(entry.repoId))
													}
												>
													{entry.goldenBuilding ? "Building…" : "Rebuild image"}
												</Button>
											)}
											<Select
												label={`Warm running containers for ${entry.repoId}`}
												value={String(entry.config.running)}
												options={POOL_COUNT_OPTIONS}
												onChange={(v) =>
													apply(
														updatePreviewPool(entry.repoId, {
															running: parseInt(v, 10),
														}),
													)
												}
											/>
											<Select
												label={`Paused spare containers for ${entry.repoId}`}
												value={String(entry.config.paused)}
												options={POOL_COUNT_OPTIONS}
												onChange={(v) =>
													apply(
														updatePreviewPool(entry.repoId, {
															paused: parseInt(v, 10),
														}),
													)
												}
											/>
										</>
									)}
									<Switch
										aria-label={`Preview pool for ${entry.repoId}`}
										checked={entry.config.enabled}
										onCheckedChange={(v) =>
											apply(updatePreviewPool(entry.repoId, { enabled: v }))
										}
									/>
								</div>
							}
						/>
					);
				})}
			</SettingCard>
			<SettingsHint>
				Keeps preview sandboxes ready from a nightly image, so the Preview button
				claims one in seconds instead of a cold boot. Claims follow the
				session's branch and are released on stop.
			</SettingsHint>
		</>
	);
}

/** Prewarming: the two pre-provisioned things that make a session start fast —
 * dependency trees for its worktree, dev-server containers for its preview.
 * Both are the same shape (a per-repo toggle with a status line), which is why
 * they read better as two groups of one page than as two pages. */
export function PrewarmingPanel() {
	return (
		<SettingsPanel>
			<SettingsHeader
				title="Session acceleration"
				description="Host-side caches and preview capacity that make sessions start quickly. Project snapshots for remote sandboxes live in Sandboxes."
			/>
			<WarmPreviewsPanel />
			<PreviewPoolPanel />
		</SettingsPanel>
	);
}
