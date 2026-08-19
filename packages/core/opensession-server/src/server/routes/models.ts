/**
 * Model catalog + default model + per-model default engine, sandbox capability/prewarm, branch-name suggestion, voice transcription.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { DIAL_PRESETS, KNOWN_MODELS, ORCHESTRATOR_PRESETS, accountProviderForModel, getDefaultModel, getModelFallbackAuto, interactiveDefaultModel, modelEfforts, modelEngineKey, refreshOpencodePickerModels, setDefaultModel, setInteractiveDefaultModel, setModelFallbackAuto, toOpencodeModel } from "../models";
import { ENGINE_IDS, modelEngineDefaults, setModelEngineDefault, type EngineId } from "../engine/engines-config";
import { opencodeOrchestratorEnabled } from "../opencode-config";
import { piEngineEnabled } from "../pi-config";
import { type Sandbox } from "../sandbox";
import { suggestBranchName } from "../suggest-branch";
import { suggestRepos } from "../suggest-repos";
import { MAX_AUDIO_BYTES, transcribeAudio } from "../transcribe";
import { supportsOpenaiFastMode } from "../opencode-openai-auth";
import { getWorkspace, workspaceModelSettings } from "../workspaces";

/** Engine ids in picker order, with their labels and whether each one can
 *  actually run a turn right now. "Available" is deliberately cheap and
 *  local (configured/enabled); it is not a liveness probe. */
function availableEngines(): { id: EngineId; label: string; available: boolean }[] {
	return [
		{
			id: "opencode",
			label: "OpenCode",
			// Configured = the picker has opencode entries to offer (bridge on, or
			// a keyed third-party provider). Same signal the model list uses.
			available: KNOWN_MODELS.some((m) => m.provider === "opencode"),
		},
		{ id: "pi", label: "Pi", available: piEngineEnabled() },
	];
}

export async function handleModelsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Models available to sessions ──
	if (path === "/api/models" && req.method === "GET") {
		// Re-fold the opencode entries from config on every fetch (cheap, tiny
		// JSON reads — same "read fresh" contract as /sandbox/status below) so a
		// config flip like the Orchestrator opt-in shows up on the next picker
		// open, not the next restart/settings-save.
		refreshOpencodePickerModels();
		const workspace = url.searchParams.get("workspace")
			? getWorkspace(url.searchParams.get("workspace")!)
			: null;
		const settings = workspaceModelSettings(workspace);
		// One engine-agnostic list: every entry (models and presets alike) runs
		// on any configured engine — the composer's Engine choice routes it by
		// prefix at dispatch (`engines` below is the only engine signal). Native
		// claude/codex ids stay resolvable + executable (the direct
		// Slack/Linear/Plain agent loops still run them on the SDK), just not
		// selectable here. Guard: with no engine configured, fall back to the
		// full registry so the picker is never empty.
		const engineModels = KNOWN_MODELS.filter((m) => m.provider === "opencode");
		const engineConfigured = engineModels.length > 0;
		const visibleModels = (engineConfigured ? engineModels : KNOWN_MODELS)
			.filter((model) => model.group !== "dial" && model.group !== "orchestrator");
		// A workspace's editable presets replace the global ones. A request with
		// no workspace (the /new composer) gets the global Dial and, when opted
		// in, Orchestrator presets instead — the entries resolveModel already
		// serves — so the instance default (`dial/…`) always has a picker row.
		const globalPresetEntry = (
			p: { id: string; label: string; description: string },
			group: "dial" | "orchestrator",
		) => ({
			id: p.id,
			provider: "opencode" as const,
			label: p.label,
			aliases: [] as string[],
			group,
			description: p.description,
		});
		const presetModels = workspace ? (settings.presets || [])
			.filter((preset) =>
				/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(preset.id) &&
				!!preset.label?.trim() && !!preset.lead?.model?.trim(),
			)
			.map((preset) => ({
				id: `workspace-preset/${workspace!.id}/${preset.id}`,
				provider: "opencode" as const,
				label: preset.label.trim(),
				aliases: [],
				group: preset.group || "custom",
				description: [
					preset.instructions?.trim() || "Workspace model combination",
					`${preset.lead.model}${preset.supporting?.length ? ` + ${preset.supporting.length} supporting model${preset.supporting.length === 1 ? "" : "s"}` : ""}`,
				].join(" · "),
			})) : engineConfigured
				? [
						...DIAL_PRESETS.map((p) => globalPresetEntry(p, "dial")),
						...(opencodeOrchestratorEnabled()
							? ORCHESTRATOR_PRESETS.map((p) => globalPresetEntry(p, "orchestrator"))
							: []),
					]
				: [];
		const interactiveDefault = engineConfigured ? interactiveDefaultModel() : getDefaultModel();
		// Older installations may still have a Dial/Orchestrator id as their
		// interactive default. In a workspace that id now means the matching
		// editable preset record, so the picker and the created session agree.
		const defaultForWorkspace = (() => {
			if (!workspace) return interactiveDefault;
			const pi = interactiveDefault.startsWith("pi/");
			const legacyId = (pi ? interactiveDefault.slice(3) : interactiveDefault)
				.toLowerCase();
			const presetId = legacyId === "dial/opus-fable"
				? "opus-fable"
				: legacyId.replace(/\//g, "-");
			const preset = settings.presets?.find((item) => item.id.toLowerCase() === presetId);
			return preset
				? `${pi ? "pi/" : ""}workspace-preset/${workspace.id}/${preset.id}`
				: interactiveDefault;
		})();
		return Response.json({
			models: [...presetModels, ...visibleModels].map((model) => ({
				...model,
				efforts: modelEfforts(model.id),
				accountProvider: accountProviderForModel(model.id),
				fastModeSupported: supportsOpenaiFastMode(toOpencodeModel(model.id)),
			})),
			default: defaultForWorkspace,
			autoFallback: getModelFallbackAuto(),
			// The engines a model can be routed to, and which of them are ready
			// to run: the composer's Engine choice composes the engine's prefix
			// onto whatever model is selected (models.ts routeModel).
			engines: availableEngines(),
			// Per-model default engine, keyed by the engine-stripped base id.
			modelEngines: modelEngineDefaults(),
		});
	}

	// Audit-backed real-work scorecard. This is evidence for the human
	// sandbox-default decision, never an automatic config mutation.
	if (path === "/api/sandbox/scorecard" && req.method === "GET") {
		const requested = Number(url.searchParams.get("days") || 30);
		const days = Number.isFinite(requested)
			? Math.min(90, Math.max(1, Math.floor(requested)))
			: 30;
		const { readSandboxScorecard } = await import("../sandbox/scorecard");
		return Response.json(readSandboxScorecard(days));
	}

	// Warm-on-typing sandbox prewarm (src/server/sandbox/prewarm.ts):
	// the New-session palette POSTs {provider, repo, user} on the first
	// keystroke (and ~every 60s while typing) with a REMOTE provider
	// selected, so the 30-45s runner bootstrap runs while the prompt is
	// being written; the create's ensure() then ADOPTS the warmed
	// sandbox. Cheap + idempotent (a live prewarm is just TTL-touched),
	// rate-limited per user, and validation lives in requestPrewarm —
	// unknown provider/repo answer {state:"unsupported"}, no-remote
	// setups {state:"disabled"}. Frontend swallows every failure.
	if (path === "/api/sandbox/prewarm" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		const provider = typeof body?.provider === "string" ? body.provider : "";
		const repoId = typeof body?.repo === "string" ? body.repo : "";
		const user = requestUser(ctx, body?.user) || "anon";
		const { requestPrewarm, prewarmRateLimited } = await import(
			"../../server/sandbox/prewarm"
		);
		if (prewarmRateLimited(user)) {
			return Response.json({ state: "rate-limited" }, { status: 429 });
		}
		return Response.json(await requestPrewarm(provider, repoId, user));
	}

	// Toggle interactive auto model-switch (manual vs auto) on running out
	// of credits. { auto: boolean }.
	if (path === "/api/models/auto-fallback" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.auto !== "boolean") {
			return Response.json(
				{ error: "auto (boolean) is required" },
				{ status: 400 },
			);
		}
		return Response.json({
			autoFallback: setModelFallbackAuto(body.auto),
		});
	}

	// Suggest a branch name from a task prompt (one no-tools Haiku call).
	// Used to auto-fill the New Session "Branch name" field as you type.
	if (path === "/api/suggest-branch" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		const prompt = typeof body?.prompt === "string" ? body.prompt : "";
		const branch = await suggestBranchName(prompt);
		return Response.json({ branch });
	}

	// Which repo(s) a task belongs in — the New-session picker's Auto mode,
	// previewed as you type. `repo: null` is a real answer ("no repo"), so the
	// caller distinguishes it from `suggestion: null` (nothing to go on, or the
	// classifier didn't answer in time — keep showing the default).
	if (path === "/api/suggest-repos" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		const prompt = typeof body?.prompt === "string" ? body.prompt : "";
		const mode = body?.mode === "ask" ? "ask" : "code";
		return Response.json({ suggestion: await suggestRepos(prompt, { mode }) });
	}

	// Voice dictation: raw audio body (whatever MediaRecorder produced) in,
	// transcribed text out. Providers chain in src/server/transcribe.ts —
	// hosted keys when configured, local whisper.cpp otherwise.
	if (path === "/api/transcribe" && req.method === "POST") {
		try {
			const audio = await req.blob();
			if (audio.size === 0) {
				return Response.json({ error: "empty audio" }, { status: 400 });
			}
			if (audio.size > MAX_AUDIO_BYTES) {
				return Response.json({ error: "audio too large" }, { status: 413 });
			}
			const mime = req.headers.get("content-type") || "audio/webm";
			const result = await transcribeAudio(audio, mime);
			return Response.json(result);
		} catch (e: any) {
			console.error("[transcribe]", e);
			return Response.json(
				{ error: e?.message || "transcription failed" },
				{ status: 500 },
			);
		}
	}

	// Set (or clear, with engine:null) the default ENGINE for one model —
	// { model: "<base id>", engine: "<engine id>" | null }. Interactive
	// sessions on that model route to this engine unless their model id names
	// one explicitly (models.ts routeModel).
	if (path === "/api/models/engine-default" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		const model = typeof body?.model === "string" ? body.model.trim() : "";
		if (!model) {
			return Response.json(
				{ error: "model (base id) is required" },
				{ status: 400 },
			);
		}
		const engine = body?.engine ?? null;
		if (engine !== null && !ENGINE_IDS.includes(engine)) {
			return Response.json(
				{ error: `engine must be one of ${ENGINE_IDS.join(", ")}, or null to clear` },
				{ status: 400 },
			);
		}
		try {
			// Store the engine-stripped id whatever the caller sent, so one entry
			// covers a model however it was written.
			return Response.json({
				modelEngines: setModelEngineDefault(modelEngineKey(model), engine as EngineId | null),
			});
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to set the default engine" },
				{ status: 400 },
			);
		}
	}

	// Set (or clear, with model:null) the default model new sessions run on.
	if (path === "/api/models/default" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		// Two independent knobs: `model` = the global default (Slack/Linear/
		// Plain loops, workflows); `interactiveModel` = what NEW interactive
		// sessions start on (the composer's preselected row — dial ids OK).
		if (!body || (!("model" in body) && !("interactiveModel" in body))) {
			return Response.json(
				{ error: "model or interactiveModel is required (id, or null to clear)" },
				{ status: 400 },
			);
		}
		try {
			if ("model" in body) {
				setDefaultModel(body.model ?? null);
				// The Settings control is the default for new sessions too. Keep the
				// historic interactive override only when an API caller explicitly
				// supplies one, so the two defaults cannot silently diverge.
				if (!("interactiveModel" in body))
					setInteractiveDefaultModel(body.model ?? null);
			}
			if ("interactiveModel" in body)
				setInteractiveDefaultModel(body.interactiveModel ?? null);
			return Response.json({
				default: getDefaultModel(),
				interactiveDefault: interactiveDefaultModel(),
			});
		} catch (e: any) {
			return Response.json(
				{ error: e?.message || "Failed to set default model" },
				{ status: 400 },
			);
		}
	}

	return undefined;
}
