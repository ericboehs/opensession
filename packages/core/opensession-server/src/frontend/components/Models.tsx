import { BASE_PATH } from "../lib/base";
import { useEffect, useState } from "react";
import { BrandMark } from "./BrandTile";
import { shortModelLabel, splitModelOptions } from "./ModelEffortSelect";
import { fetchEngines, setModelEngineDefault } from "../lib/api/engines";
import {
	engineModelId,
	modelEngineKey,
	type EngineId,
	type EngineOption,
} from "../lib/model-engine";
import { Select } from "../ui/select";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { Menu } from "../ui/menu";
import { IconChevronRight, IconPlus } from "./icons";
import { EmptyState, InlineAlert } from "../ui/state";
import {
	SettingCard,
	SettingRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHint,
} from "../ui/settings";
import { Switch } from "../ui/switch";
import { toast } from "../ui/toast";

// Settings → Models: which model a run starts on and which engine carries it.
// The subscription accounts those runs draw from, and how full they are, moved
// to Settings → Usage (settings/ModelAccounts.tsx). Usage is read far more
// often than any of this is changed. Everything here follows the Settings idiom
// (setting-card row lists), not the Connections card grid.

interface ModelInfo {
	id: string;
	provider: "claude" | "codex" | "opencode";
	label: string;
	aliases: string[];
	efforts: string[];
}

/** The model half of Settings → Models: what new runs start on, and the
 * engines available to carry them. Renders as groups, not a page: Settings'
 * ModelsPanel owns the header. */
export function ModelDefaultsSection() {
	return (
		<>
			<SettingsGroupLabel className="mt-0">Default model</SettingsGroupLabel>
			<SettingCard>
				<DefaultModelRow />
				<AutoFallbackRow />
			</SettingCard>
			<SettingsHint>
				Applies to new runs immediately, with no restart. A model picked for one session still
				wins over the default.
			</SettingsHint>

			<EnginesSection />
		</>
	);
}

// ── Default model ──────────────────────────────────────────────────────────

function DefaultModelRow() {
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [current, setCurrent] = useState<string>("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => {
				if (!body) return;
				setModels(body.models);
				setCurrent(body.default);
			})
			.catch(() => {});
	}, []);

	async function handleChange(id: string) {
		if (id === current) return;
		setSaving(true);
		setError(null);
		try {
			const res = await fetch(`${BASE_PATH}/api/models/default`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: id }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setCurrent(body.default);
		} catch (e: any) {
			setError(e.message);
		}
		setSaving(false);
	}

	// Engine entries (opencode + pi) are the first-class list — opencode with
	// friendly names and no engine noise, pi keeping its registry label ("Pi ·
	// Claude Opus 5") so it never reads as a duplicate row in this flat select.
	// The native claude/codex entries stay selectable under de-emphasized
	// legacy groups while the migration lands.
	const { opencode: opencodeModels, legacy } = splitModelOptions(models || []);
	const claudeModels = legacy.filter((m) => m.provider === "claude");
	const codexModels = legacy.filter((m) => m.provider === "codex");
	const legacyGroup = (engine: string) =>
		opencodeModels.length > 0 ? `Legacy · ${engine} (direct SDK)` : engine;
	const engineLabel = (m: (typeof opencodeModels)[number]) =>
		m.provider === "pi" ? m.label : shortModelLabel(m.id, models || []);
	// The trigger reads the selected model's label from this flat list, so a
	// closed select shows "Fable 5" rather than opencode/anthropic/claude-fable-5.
	const items = [
		...opencodeModels.map((m) => ({ value: m.id, label: engineLabel(m) })),
		...claudeModels.map((m) => ({ value: m.id, label: m.label })),
		...codexModels.map((m) => ({ value: m.id, label: m.label })),
	];

	return (
		<SettingRow>
			<SettingRowText>
				<SettingRowTitle>What new sessions run on</SettingRowTitle>
				<SettingRowDescription>
					{error ||
						"Sessions and agent runs (Slack, Linear, Plain, automations without their own model) start on this."}
				</SettingRowDescription>
			</SettingRowText>
			<SettingRowControl>
				<Select.Root
					items={items}
					value={current}
					disabled={!models || saving}
					onValueChange={(id) => handleChange(String(id))}
				>
					<Select.Trigger
						aria-label="Default model"
						sizeTo={items.map((m) => m.label)}
					/>
					<Select.Popup align="end">
						{opencodeModels.map((m) => (
							<Select.Item key={m.id} value={m.id}>
								{engineLabel(m)}
							</Select.Item>
						))}
						{claudeModels.length > 0 && (
							<Select.Group>
								<Select.GroupLabel>{legacyGroup("Claude")}</Select.GroupLabel>
								{claudeModels.map((m) => (
									<Select.Item key={m.id} value={m.id}>
										{m.label}
									</Select.Item>
								))}
							</Select.Group>
						)}
						{codexModels.length > 0 && (
							<Select.Group>
								<Select.GroupLabel>{legacyGroup("Codex")}</Select.GroupLabel>
								{codexModels.map((m) => (
									<Select.Item key={m.id} value={m.id}>
										{m.label}
									</Select.Item>
								))}
							</Select.Group>
						)}
					</Select.Popup>
				</Select.Root>
			</SettingRowControl>
		</SettingRow>
	);
}

// ── Auto model-switch on out-of-credits ─────────────────────────────────────

/**
 * Manual vs auto: when a session's model runs out of usage credits pool-wide,
 * either drop it to a fallback model and keep going (auto, the default) or stop
 * on the limit notice and let the human pick the next model (manual). Global,
 * read fresh per run. The switch is always announced in the session as a divider.
 */
function AutoFallbackRow() {
	const [auto, setAuto] = useState<boolean | null>(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setAuto(body.autoFallback !== false))
			.catch(() => {});
	}, []);

	async function toggle(next: boolean) {
		if (saving) return;
		setSaving(true);
		setError(null);
		const prev = auto;
		setAuto(next); // optimistic
		try {
			const res = await fetch(`${BASE_PATH}/api/models/auto-fallback`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ auto: next }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setAuto(body.autoFallback);
		} catch (e: any) {
			setError(e.message);
			setAuto(prev ?? null);
		}
		setSaving(false);
	}

	const on = auto ?? true;
	return (
		<SettingRow>
			<SettingRowText>
				<SettingRowTitle>Auto-switch when out of credits</SettingRowTitle>
				<SettingRowDescription>
					{error ||
						"When a run has an explicit fallback model and the current model runs out of usage credits, keep going on that configured fallback. Off = the run halts and you pick the next model. Either way the switch shows in the session."}
				</SettingRowDescription>
			</SettingRowText>
			<SettingRowControl>
				<Switch
					checked={on}
					aria-label="Auto-switch model when out of credits"
					disabled={auto === null || saving}
					onCheckedChange={toggle}
				/>
			</SettingRowControl>
		</SettingRow>
	);
}

// ── Engines ────────────────────────────────────────────────────────────────

interface PiEngineConfig {
	enabled: boolean;
	pickerModels?: string[];
}

/**
 * Engine switches: OpenCode (the default engine) and pi, plus which engine
 * new sessions default to. Models and presets are shared by both engines.
 */
function EnginesSection() {
	const [ocEnabled, setOcEnabled] = useState<boolean | null>(null);
	const [pi, setPi] = useState<PiEngineConfig | null>(null);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/settings/opencode-engine`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setOcEnabled(body.enabled === true))
			.catch(() => {});
		fetch(`${BASE_PATH}/api/settings/pi-engine`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setPi(body))
			.catch(() => {});
	}, []);

	async function toggleOpencode(next: boolean) {
		if (saving) return;
		setSaving(true);
		setError(null);
		const prev = ocEnabled;
		setOcEnabled(next);
		try {
			const res = await fetch(`${BASE_PATH}/api/settings/opencode-engine`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setOcEnabled(body.enabled === true);
		} catch (e: any) {
			setOcEnabled(prev);
			setError(e.message);
			toast(e.message, { variant: "error" });
		}
		setSaving(false);
	}

	async function togglePi(next: boolean) {
		if (saving || !pi) return;
		setSaving(true);
		setError(null);
		const prev = pi;
		setPi({ ...pi, enabled: next });
		try {
			const res = await fetch(`${BASE_PATH}/api/settings/pi-engine`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: next }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setPi(body);
		} catch (e: any) {
			setPi(prev);
			setError(e.message);
			toast(e.message, { variant: "error" });
		}
		setSaving(false);
	}

	async function handleTestPi() {
		if (testing) return;
		setTesting(true);
		try {
			const res = await fetch(`${BASE_PATH}/api/admin/pi-smoke`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const body = await res.json();
			if (body.ok) toast(body.text || "Pi engine turn completed", { variant: "success" });
			else toast(body.reason || body.error || "Pi smoke turn failed", { variant: "error" });
		} catch (e: any) {
			toast(e.message || "Pi smoke turn failed", { variant: "error" });
		}
		setTesting(false);
	}

	return (
		<>
			<SettingsGroupLabel>Engines</SettingsGroupLabel>

			{error && (
				<InlineAlert className="mb-2" onDismiss={() => setError(null)}>
					{error}
				</InlineAlert>
			)}

			<SettingCard>
				<SettingRow>
					<SettingRowText>
						<SettingRowTitle>OpenCode engine</SettingRowTitle>
						<SettingRowDescription>
							The default engine: Anthropic models on the Claude account pool via the
							Meridian bridge, OpenAI models on the codex pool, plus API-key providers.
						</SettingRowDescription>
					</SettingRowText>
					<SettingRowControl>
						<Switch
							checked={ocEnabled ?? false}
							aria-label="Enable the OpenCode engine"
							disabled={ocEnabled === null || saving}
							onCheckedChange={toggleOpencode}
						/>
					</SettingRowControl>
				</SettingRow>

				<SettingRow>
					<SettingRowText>
						<SettingRowTitle>Pi engine</SettingRowTitle>
						<SettingRowDescription>
							pi.dev's coding agent as an alternative engine on the same models and account pools.
						</SettingRowDescription>
					</SettingRowText>
					<SettingRowControl className="flex items-center gap-2.5">
						<Button size="sm" onClick={handleTestPi} disabled={testing || !pi?.enabled}>
							{testing ? "Running…" : "Test"}
						</Button>
						<Switch
							checked={pi?.enabled ?? false}
							aria-label="Enable the pi engine"
							disabled={!pi || saving}
							onCheckedChange={togglePi}
						/>
					</SettingRowControl>
				</SettingRow>

				<DefaultEngineRow piEnabled={pi?.enabled ?? false} />
			</SettingCard>
			<SettingsHint>
				Choose a model or preset once, then choose which engine runs it. Changes apply to new runs.
			</SettingsHint>
		</>
	);
}

/**
 * Per-model default engine. The engine a session runs on is the model id's
 * routing prefix, so this map only decides where a model goes when nobody has
 * picked: an explicit choice in the composer still wins, and a model with no
 * override runs on the instance default engine.
 *
 * It lists the OVERRIDES, not the catalog. A row per model was a wall of
 * identical Auto selects between the page's two real settings, and every one
 * of them said the same thing the absence of a row says. So the list is
 * usually empty, an override is added from the group's own menu (model, then
 * engine), and setting a row back to Auto removes it.
 *
 * Hidden unless the server offers more than one engine — with one engine there
 * is nothing to choose, and an older server sends no engine list at all.
 */
export function ModelEngineDefaultsSection() {
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [engines, setEngines] = useState<EngineOption[]>([]);
	const [defaults, setDefaults] = useState<Record<string, EngineId>>({});
	const [saving, setSaving] = useState<string | null>(null);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setModels(body.models))
			.catch(() => {});
		fetchEngines()
			.then((c) => {
				setEngines(c.engines.filter((e) => e.available));
				setDefaults(c.modelEngines);
			})
			.catch(() => {});
	}, []);

	async function handleChange(key: string, value: string) {
		const engine = value ? (value as EngineId) : null;
		setSaving(key);
		const previous = defaults;
		setDefaults((prev) => {
			const next = { ...prev };
			if (engine) next[key] = engine;
			else delete next[key];
			return next;
		});
		try {
			setDefaults(await setModelEngineDefault(key, engine));
		} catch (e: any) {
			setDefaults(previous);
			toast(e.message || "Failed to save the default engine", { variant: "error" });
		}
		setSaving(null);
	}

	if (engines.length < 2) return null;
	const { opencode: engineModels } = splitModelOptions(models || []);
	if (engineModels.length === 0) return null;
	// One entry per stored key: modelEngineKey drops the provider segment, so
	// two picker entries can land on the same key and only one row owns it.
	const byKey = new Map<string, (typeof engineModels)[number]>();
	for (const m of engineModels) {
		const key = modelEngineKey(m.id);
		if (!byKey.has(key)) byKey.set(key, m);
	}
	const entries = [...byKey];
	const pinned = entries.filter(([key]) => defaults[key]);
	const unpinned = entries.filter(([key]) => !defaults[key]);
	const label = (m: (typeof engineModels)[number]) => shortModelLabel(m.id, models || []);
	// "" is the real stored value for "no default engine", not a placeholder.
	const engineItems = [
		{ value: "", label: "Auto" },
		...engines.map((e) => ({ value: e.id as string, label: e.label })),
	];

	return (
		<>
			<SettingsGroupLabel
				actions={
					unpinned.length > 0 ? (
						<Menu.Root>
							<Menu.Trigger
								render={
									<Button size="sm" icon={<IconPlus size={16} />}>
										Add override
									</Button>
								}
							/>
							<Menu.Popup align="end" className="max-w-[min(360px,calc(100vw-1rem))]">
								{unpinned.map(([key, m]) => (
									<Menu.SubmenuRoot key={key}>
										<Menu.SubmenuTrigger className="justify-between gap-3">
											<span className="min-w-0 truncate">{label(m)}</span>
											<IconChevronRight className="shrink-0 text-dim" size={17} />
										</Menu.SubmenuTrigger>
										<Menu.Popup className="max-w-[min(360px,calc(100vw-1rem))]">
											{engines.map((e) => {
												// An engine that can't run the model stays visible
												// but unpickable, the way the composer lists it —
												// hiding it would read as "not configured".
												const unavailable = !engineModelId(e.id, m.id);
												return (
													<Menu.Item
														key={e.id}
														disabled={unavailable}
														title={
															unavailable
																? `${label(m)} isn't available on the ${e.label} engine`
																: undefined
														}
														className={cn(unavailable && "opacity-55")}
														onClick={() => void handleChange(key, e.id)}
													>
														<span className="flex size-4 shrink-0 items-center justify-center text-dim">
															<BrandMark name={e.id} />
														</span>
														<span className="min-w-0 truncate">{e.label}</span>
													</Menu.Item>
												);
											})}
										</Menu.Popup>
									</Menu.SubmenuRoot>
								))}
							</Menu.Popup>
						</Menu.Root>
					) : undefined
				}
			>
				Default engine per model
			</SettingsGroupLabel>
			<SettingCard>
				{pinned.length === 0 ? (
					<EmptyState placement="row">Every model runs on the default engine.</EmptyState>
				) : (
					pinned.map(([key, m]) => {
						const value = defaults[key] || "";
						return (
							<SettingRow key={key}>
								<SettingRowText>
									<SettingRowTitle>{label(m)}</SettingRowTitle>
								</SettingRowText>
								<SettingRowControl>
									<Select.Root
										items={engineItems}
										value={value}
										disabled={saving === key}
										onValueChange={(engine) => handleChange(key, String(engine))}
									>
										<Select.Trigger
											aria-label={`Default engine for ${label(m)}`}
											icon={<BrandMark name={value} />}
											sizeTo={engineItems.map((e) => e.label)}
										/>
										<Select.Popup align="end">
											{engineItems.map((e) => (
												<Select.Item
													key={e.value}
													value={e.value}
													disabled={!!e.value && !engineModelId(e.value as EngineId, m.id)}
													icon={<BrandMark name={e.value} />}
												>
													{e.label}
												</Select.Item>
											))}
										</Select.Popup>
									</Select.Root>
								</SettingRowControl>
							</SettingRow>
						);
					})
				)}
			</SettingCard>
			<SettingsHint>
				An override pins one model to one engine. Set a row back to Auto to remove it. A
				model an engine can't serve is not offered for it.
			</SettingsHint>
		</>
	);
}

/**
 * Which engine new sessions default to. Flips the default model's engine
 * prefix while keeping the same provider/model tail — the model choice itself
 * stays in the Default model select above.
 */
function DefaultEngineRow({ piEnabled }: { piEnabled: boolean }) {
	const [current, setCurrent] = useState<string>("");
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		fetch(`${BASE_PATH}/api/models`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body) => body && setCurrent(body.default))
			.catch(() => {});
	}, []);

	const engine = current.startsWith("pi/") ? "pi" : "opencode";
	const tail = current.startsWith("pi/")
		? current.slice("pi/".length)
		: current.startsWith("opencode/")
			? current.slice("opencode/".length)
			: null;
	const piCanServe = !!tail;
	const engineItems = [
		{ value: "opencode", label: "OpenCode" },
		{
			value: "pi",
			label: `Pi${!piEnabled ? " (disabled)" : !piCanServe ? " (model not served)" : ""}`,
		},
	];

	async function handleChange(next: string) {
		if (next === engine || !tail) return;
		const id = next === "pi" ? `pi/${tail}` : `opencode/${tail}`;
		setSaving(true);
		try {
			const res = await fetch(`${BASE_PATH}/api/models/default`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ model: id }),
			});
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			setCurrent(body.default);
			toast(`New sessions default to ${body.default}`);
		} catch (e: any) {
			toast(e.message, { variant: "error" });
		}
		setSaving(false);
	}

	return (
		<SettingRow>
			<SettingRowText>
				<SettingRowTitle>Default engine</SettingRowTitle>
				<SettingRowDescription>
					{tail
						? `Moves the default model (currently ${current}) onto the chosen engine, keeping the same model.`
						: current
							? `The default (${current}) isn't an engine-prefixed model. Pick an opencode/… or pi/… default model above to switch engines here.`
							: "Which engine new sessions start on."}
				</SettingRowDescription>
			</SettingRowText>
			<SettingRowControl>
				<Select.Root
					items={engineItems}
					value={engine}
					disabled={!current || saving || !tail}
					onValueChange={(next) => handleChange(String(next))}
				>
					<Select.Trigger
						aria-label="Default engine"
						icon={<BrandMark name={engine} />}
						sizeTo={engineItems.map((e) => e.label)}
					/>
					<Select.Popup align="end">
						{engineItems.map((e) => (
							<Select.Item
								key={e.value}
								value={e.value}
								disabled={e.value === "pi" && (!piCanServe || !piEnabled)}
								icon={<BrandMark name={e.value} />}
							>
								{e.label}
							</Select.Item>
						))}
					</Select.Popup>
				</Select.Root>
			</SettingRowControl>
		</SettingRow>
	);
}

