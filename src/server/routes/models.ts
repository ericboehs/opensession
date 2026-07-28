/**
 * Model catalog + default model, sandbox capability/prewarm, system-prompt preview, branch-name suggestion, voice transcription.
 *
 * Extracted verbatim from the opensession.ts fetch chain. Every handler
 * returns a Response for a matched route or undefined to fall through to the
 * next handler (see routes/index.ts for the dispatch order).
 */

import { requestUser, type RouteContext } from "./context";
import { KNOWN_MODELS, accountProviderForModel, getDefaultModel, getModelFallbackAuto, interactiveDefaultModel, localProfileDefaultModel, localProfileModels, modelEfforts, refreshOpencodePickerModels, setDefaultModel, setInteractiveDefaultModel, setModelFallbackAuto, toOpencodeModel } from "../models";
import { envAlias } from "../rename-compat";
import { type Sandbox } from "../sandbox";
import { sandboxCapabilityStatus } from "../sandbox/config";
import { suggestBranchName } from "../suggest-branch";
import { buildSystemPromptParts } from "../system-prompt";
import { MAX_AUDIO_BYTES, transcribeAudio } from "../transcribe";
import { isLocalProfile } from "../profile";
import { supportsOpenaiFastMode } from "../opencode-openai-auth";
import { configuredServer } from "../config";

export async function handleModelsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, url, path, publicPrefix } = ctx;

	// ── Models available to sessions ──
	if (path === "/backstage/api/models" && req.method === "GET") {
		if (isLocalProfile()) {
			const models = localProfileModels();
			return Response.json({
				models: models.map((model) => ({
					...model,
					efforts: modelEfforts(model.id),
					accountProvider: accountProviderForModel(model.id),
					fastModeSupported: supportsOpenaiFastMode(toOpencodeModel(model.id)),
				})),
				default: localProfileDefaultModel(),
				autoFallback: false,
			});
		}
		// Re-fold the opencode entries from config on every fetch (cheap, tiny
		// JSON read — same "read fresh" contract as /sandbox/status below) so a
		// config flip like the Orchestrator opt-in shows up on the next picker
		// open, not the next restart/settings-save.
		refreshOpencodePickerModels();
		// Single-engine core: the picker surfaces ONLY opencode models.
		// Native claude/codex ids stay resolvable + executable (the direct
		// Slack/Linear/Plain agent loops still run them on the SDK), just
		// not selectable here. Guard: with opencode not configured, fall
		// back to the full registry so the picker is never empty.
		const opencodeOnly = KNOWN_MODELS.filter((m) => m.provider === "opencode");
		const opencodeConfigured = opencodeOnly.length > 0;
		return Response.json({
			models: (opencodeConfigured ? opencodeOnly : KNOWN_MODELS).map((model) => ({
				...model,
				efforts: modelEfforts(model.id),
				accountProvider: accountProviderForModel(model.id),
				fastModeSupported: supportsOpenaiFastMode(toOpencodeModel(model.id)),
			})),
			default: opencodeConfigured ? interactiveDefaultModel() : getDefaultModel(),
			autoFallback: getModelFallbackAuto(),
		});
	}

	// Sandbox capability status for the session-create provider picker:
	// {enabled, defaultProvider, providers: [{id, configured, note?}],
	// killSwitch}. Read fresh from ~/.opensession-sandbox.json + the
	// kill-switch file on every call, so a config flip shows up on the
	// next fetch. Behavior is unit-tested via sandboxCapabilityStatus()
	// (src/server/sandbox/capability-status.test.ts).
	if (path === "/backstage/api/sandbox/status" && req.method === "GET") {
		return Response.json(sandboxCapabilityStatus());
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
	if (path === "/backstage/api/sandbox/prewarm" && req.method === "POST") {
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

	// What an interactive session will be told on top of the claude_code
	// preset — previewed in the New Session modal. Same builder the runner
	// uses (src/server/system-prompt.ts), so this can't drift from reality.
	if (path === "/backstage/api/system-prompt" && req.method === "GET") {
		const isAsk = url.searchParams.get("mode") === "ask";
		return Response.json({
			preset: "claude_code",
			settingSources: ["user", "project"],
			parts: buildSystemPromptParts({
				isAsk,
				sessionLink: isAsk
					? undefined
					: `${envAlias("OPENSESSION_UI_BASE", "MICHAEL_UI_BASE") || configuredServer().publicBaseUrl}/session/<this-session>`,
				user: url.searchParams.get("user") || undefined,
				interactiveTools: true,
			}),
		});
	}

	// Toggle interactive auto model-switch (manual vs auto) on running out
	// of credits. { auto: boolean }.
	if (path === "/backstage/api/models/auto-fallback" && req.method === "PUT") {
		const body = await req.json().catch(() => null);
		if (!body || typeof body.auto !== "boolean") {
			return Response.json(
				{ error: "auto (boolean) is required" },
				{ status: 400 },
			);
		}
		return Response.json({
			autoFallback: isLocalProfile() ? false : setModelFallbackAuto(body.auto),
		});
	}

	// Suggest a branch name from a task prompt (one no-tools Haiku call).
	// Used to auto-fill the New Session "Branch name" field as you type.
	if (path === "/backstage/api/suggest-branch" && req.method === "POST") {
		const body = await req.json().catch(() => null);
		const prompt = typeof body?.prompt === "string" ? body.prompt : "";
		const branch = await suggestBranchName(prompt);
		return Response.json({ branch });
	}

	// Voice dictation: raw audio body (whatever MediaRecorder produced) in,
	// transcribed text out. Providers chain in src/server/transcribe.ts —
	// hosted keys when configured, local whisper.cpp otherwise.
	if (path === "/backstage/api/transcribe" && req.method === "POST") {
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

	// Set (or clear, with model:null) the default model new sessions run on.
	if (path === "/backstage/api/models/default" && req.method === "PUT") {
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
			if ("model" in body) setDefaultModel(body.model ?? null);
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
