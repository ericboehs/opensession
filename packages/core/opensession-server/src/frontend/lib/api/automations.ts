import { ApiError, BASE, request } from "./request";

// ── Automations ──

export interface ModelOption {
	id: string;
	provider: "claude" | "codex" | "pi";
	label: string;
	aliases: string[];
	efforts: string[];
	/** Presets fix the lead model's effort instead of offering a ladder. */
	fixedEffort?: string;
	/** Provider account pool available to this model, if any. */
	accountProvider?: "claude" | "codex";
	/** Picker section override ("dial" = The Dial presets). */
	group?: string;
	/** One-line subtitle shown under the label (dial presets). */
	description?: string;
	/** This model has subscription-backend priority-tier variants configured. */
	fastModeSupported?: boolean;
}

type ModelCatalog = { models: ModelOption[]; default: string };
const MODEL_CACHE_MS = 60_000;
const modelCatalogCache = new Map<string, { value: ModelCatalog; fetchedAt: number; pending?: Promise<ModelCatalog> }>();

function modelCatalogKey(workspaceId?: string): string {
	return workspaceId || "global";
}

async function refreshModelCatalog(workspaceId?: string): Promise<ModelCatalog> {
	const key = modelCatalogKey(workspaceId);
	const current = modelCatalogCache.get(key);
	if (current?.pending) return current.pending;
	const params = new URLSearchParams();
	if (workspaceId) params.set("workspace", workspaceId);
	const pending = request<ModelCatalog>(`/models${params.size ? `?${params}` : ""}`, {
		label: "Failed to fetch models",
	}).then((value) => {
		modelCatalogCache.set(key, { value, fetchedAt: Date.now() });
		return value;
	}).finally(() => {
		const entry = modelCatalogCache.get(key);
		if (entry?.pending) delete entry.pending;
	});
	modelCatalogCache.set(key, { value: current?.value || { models: [], default: "" }, fetchedAt: current?.fetchedAt || 0, pending });
	return pending;
}

/** Clear one workspace's picker catalog after its preset settings change. */
export function invalidateModelsCache(workspaceId?: string): void {
	for (const key of modelCatalogCache.keys()) {
		if (!workspaceId || key.endsWith(`:${workspaceId}`)) modelCatalogCache.delete(key);
	}
}

/**
 * Ask the backend (a quick Haiku call) to suggest a branch name for a task
 * prompt. Returns null when the prompt is too thin or anything fails — callers
 * just leave the field for the user to fill.
 */
export async function suggestBranch(prompt: string): Promise<string | null> {
	try {
		const data = await request<{ branch?: unknown }>("/suggest-branch", {
			method: "POST",
			body: { prompt },
		});
		return typeof data?.branch === "string" ? data.branch : null;
	} catch {
		return null;
	}
}

/** What the picker's Auto mode resolved a prompt to. */
export interface RepoSuggestion {
	/** The repo the session should sit in; null means "no repo". */
	repo: string | null;
	/** Repos to attach beside it. */
	extras: string[];
	/** One short clause naming the evidence, shown under the picker. */
	reason: string;
	source: "named" | "model";
}

/**
 * Ask the backend which repo(s) a task belongs in — the New-session picker's
 * Auto mode. Takes a beat (the classifier reads every registered repo's layout
 * and docs), so callers treat it the way the branch field treats
 * `suggestBranch`: fill it in when it lands.
 *
 * Null means "no answer" — nothing to go on, or it didn't come back in time —
 * which is NOT the same as a suggestion whose `repo` is null ("no repo").
 */
export async function suggestRepos(
	prompt: string,
	mode: "ask" | "code",
): Promise<RepoSuggestion | null> {
	try {
		const data = await request<{ suggestion?: unknown }>("/suggest-repos", {
			method: "POST",
			body: { prompt, mode },
		});
		const s = data?.suggestion as RepoSuggestion | null | undefined;
		if (!s || typeof s !== "object") return null;
		return {
			repo: typeof s.repo === "string" ? s.repo : null,
			extras: Array.isArray(s.extras) ? s.extras.filter((x) => typeof x === "string") : [],
			reason: typeof s.reason === "string" ? s.reason : "",
			source: s.source === "named" ? "named" : "model",
		};
	} catch {
		return null;
	}
}

/** Voice dictation: send a recorded clip (raw body), get the transcript back.
 * Bypasses `request` — the body is audio bytes, not JSON. */
export async function transcribeClip(audio: Blob): Promise<string> {
	const res = await fetch(`${BASE}/transcribe`, {
		method: "POST",
		headers: { "Content-Type": audio.type || "audio/webm" },
		body: audio,
	});
	const data = (await res.json().catch(() => null)) as { text?: unknown; error?: unknown } | null;
	if (!res.ok) {
		throw new ApiError(
			typeof data?.error === "string" ? data.error : `Transcribe: ${res.status}`,
			res.status,
		);
	}
	return typeof data?.text === "string" ? data.text : "";
}

export async function fetchModels(workspaceId?: string): Promise<{
	models: ModelOption[];
	default: string;
}> {
	const cached = modelCatalogCache.get(modelCatalogKey(workspaceId));
	if (cached?.value.models.length) {
		if (Date.now() - cached.fetchedAt > MODEL_CACHE_MS)
			void refreshModelCatalog(workspaceId).catch(() => {});
		return cached.value;
	}
	return refreshModelCatalog(workspaceId);
}

/** Trimmed provider account shape for the per-session account picker. */
export interface ProviderAccountOption {
	id: string;
	name: string;
	email?: string;
	provider: "claude" | "codex";
	/** Personal-sub owner, if any (else it's a shared-pool account). */
	owner?: string;
	/** False when the account is currently exhausted / over its cap. */
	usable: boolean;
	/** Credential mechanism; Fast mode is unavailable for direct API keys. */
	kind?: string;
}

export async function fetchProviderAccounts(): Promise<ProviderAccountOption[]> {
	const fetchPool = async (provider: "claude" | "codex", path: string) => {
		try {
			const data = await request<{ accounts?: any[] }>(path);
			return (data?.accounts ?? []).map((a) => ({
				id: a.id,
				name: a.name,
				email: typeof a.email === "string" ? a.email : undefined,
				provider,
				owner: a.owner || undefined,
				usable: a.usable !== false,
				kind: typeof a.kind === "string" ? a.kind : undefined,
			}));
		} catch {
			return [];
		}
	};
	const [claude, codex] = await Promise.all([
		fetchPool("claude", "/claude-accounts"),
		fetchPool("codex", "/codex-accounts"),
	]);
	return [...claude, ...codex];
}

export async function fetchAutomations() {
	return request<any>("/automations", {
		label: "Failed to fetch automations",
	});
}

/**
 * One automation as the sidebar's Automations band needs it: who owns it,
 * where it files, and the outcome of its latest run.
 */
export interface AutomationOverview {
	id: string;
	name: string;
	enabled: boolean;
	repo?: string;
	workspaceId?: string;
	workspaceName?: string;
	/** The workspace's own repo, so the repo lens can match through it. */
	workspaceRepo?: string;
	owner?: string;
	lastRunAt?: string;
	lastRunStatus?: "running" | "ok" | "error";
	lastRunSessionId?: string;
	latestReport?: {
		id: string;
		title: string;
		summary?: string;
		urgency?: "low" | "medium" | "high" | "critical";
		confidence?: "low" | "medium" | "high";
		createdAt: string;
		sessionId?: string;
	};
}

export async function fetchAutomationOverview(): Promise<AutomationOverview[]> {
	const result = await request<{ automations: AutomationOverview[] }>(
		"/automations/overview",
		{ label: "Failed to load automations" },
	);
	return result.automations;
}

export interface AutomationTemplate {
	id: string;
	name: string;
	description: string;
	category: "sweep" | "digest" | "investigator" | "triage" | "hygiene";
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	mcpServers?: string[];
	eventKey?: string;
}

export async function fetchAutomationTemplates(): Promise<AutomationTemplate[]> {
	const res = await fetch(`${BASE}/automation-templates`);
	if (!res.ok) throw new Error(`Failed to fetch templates: ${res.status}`);
	return res.json();
}

export interface AutomationDraft {
	name: string;
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	mcpServers?: string[];
	eventKey?: string;
}

/** Draft an automation config from a free-text description (backend Haiku
 *  call). Throws with a friendly message when the draft fails. */
export async function draftAutomationApi(description: string): Promise<AutomationDraft> {
	const res = await fetch(`${BASE}/automations/draft`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ description }),
	});
	const body = await res.json();
	if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
	return body;
}

/** MCP server list + agent health, for pickers (Automations) and Settings. */
export async function fetchConnections(): Promise<{
	mcpServers: Array<{ name: string; status: string; allowedUsers?: string[] }>;
	agents: Record<string, unknown>;
	engines?: string[];
}> {
	const res = await fetch(`${BASE}/connections`);
	if (!res.ok) throw new Error(`Failed to fetch connections: ${res.status}`);
	return res.json();
}

/** Provider-independent model-family sandboxability from the server. */
export interface SandboxModelFamilyInfo {
	id: string;
	label: string;
	match: { provider: "claude" | "codex" | "pi" };
	sandboxable: boolean;
	hint?: string;
}

/** Sandbox capability status for the New-session provider picker
 *  (GET /api/sandbox/status — read fresh server-side per call). */
export interface SandboxStatusInfo {
	enabled: boolean;
	defaultProvider: string;
	providers: Array<{
		id: "docker" | "daytona" | "e2b" | "box" | "modal" | "microvm" | "lambda-microvm";
		configured: boolean;
		certified: boolean;
		lastPassedAt?: string;
		note?: string;
	}>;
	killSwitch: boolean;
	defaults?: {
		workspace: string;
		personal: string;
		effective: string;
	};
	connections?: SandboxConnectionInfo[];
	operations?: SandboxOperationInfo[];
	ingress?: SandboxIngressInfo;
	canManage?: boolean;
	/** Absent on a pre-upgrade server = no client-side combo warnings. */
	modelFamilies?: SandboxModelFamilyInfo[];
}

export type SandboxConnectionState =
	| "not_configured"
	| "checking"
	| "ready"
	| "needs_attention"
	| "disabled";

export interface SandboxConnectionInfo {
	id: string;
	provider: "docker" | "daytona" | "box" | "modal" | "microvm";
	enabled: boolean;
	settings: Record<string, string | number | boolean | undefined>;
	qualification?: {
		status: "checking" | "ready" | "failed";
		adapterSignature: string;
		checkedAt?: string;
		failureCode?: string;
		failureSummary?: string;
	};
	createdAt: string;
	updatedAt: string;
	hasCredentials: boolean;
	state: SandboxConnectionState;
}

export interface SandboxOperationInfo {
	id: string;
	kind: "qualification" | "repair" | "environment_rebuild";
	provider: string;
	repo?: string;
	status: "running" | "succeeded" | "failed";
	stage: string;
	detail?: string;
	progress?: number;
	createdAt: string;
	updatedAt: string;
	failureCode?: string;
	failureSummary?: string;
}

export interface SandboxIngressInfo {
	configuredUrl?: string;
	proposedUrl?: string;
	source: "sandbox_config" | "caddy_webhook" | "public_ui" | "none";
	health: "ready" | "unreachable" | "not_configured";
	caddyAdminReachable: boolean;
	generatedSnippet: string;
	note?: string;
}

export async function fetchSandboxStatus(user?: string): Promise<SandboxStatusInfo> {
	const query = user ? `?user=${encodeURIComponent(user)}` : "";
	const res = await fetch(`${BASE}/sandbox/status${query}`);
	if (!res.ok) throw new Error(`Failed to fetch sandbox status: ${res.status}`);
	return res.json();
}

export async function saveSandboxDefault(input: {
	scope: "workspace" | "personal";
	value: string;
	user: string;
}): Promise<{ defaults: NonNullable<SandboxStatusInfo["defaults"]> }> {
	return request("/sandbox/defaults", { method: "PUT", body: input });
}

/** Warm-on-typing sandbox prewarm (POST /api/sandbox/prewarm): fired by the
 *  New-session palette when the user types with a REMOTE provider selected,
 *  so the sandbox bootstrap runs while they write the prompt. Idempotent and
 *  cheap server-side; callers must swallow failures (never block typing). */
export async function requestSandboxPrewarm(
	provider: string,
	repo: string,
	user: string,
): Promise<{ state: string }> {
	const res = await fetch(`${BASE}/sandbox/prewarm`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ provider, repo, user }),
	});
	if (!res.ok) throw new Error(`prewarm failed: ${res.status}`);
	return res.json();
}

export async function createAutomationApi(input: {
	name: string;
	prompt: string;
	schedule: string;
	mode: "ask" | "code";
	createdBy: string;
	eventKey?: string;
	model?: string;
	fallbackModel?: string;
	accountId?: string;
	accountStrict?: boolean;
	usageCredits?: boolean;
	sandbox?: boolean;
	mcpServers?: string[];
	slackWatch?: { channel: string };
	webhookEnabled?: boolean;
	inputs?: unknown[];
	outputs?: unknown[];
	owner?: string;
	workspaceId?: string;
}) {
	return request<any>("/automations", { method: "POST", body: input });
}

export async function updateAutomationApi(id: string, patch: object) {
	return request<any>(`/automations/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function deleteAutomationApi(id: string) {
	await request<void>(`/automations/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function runAutomationApi(id: string) {
	await request<void>(`/automations/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
}

/** Re-fire an automation replaying the triggering event of one of its past
 *  runs (the run is identified by its session id). */
export async function retriggerAutomationApi(sessionId: string) {
	await request<void>(`/automations/retrigger`, {
		method: "POST",
		body: { sessionId },
		label: "Failed to retrigger",
	});
}

// ── Scheduled prompts (composer "send later") ──

export interface ScheduledPrompt {
	id: string;
	sessionId: string;
	prompt: string;
	user: string;
	at: string;
	createdAt: string;
}

export async function fetchScheduledPrompts(
	sessionId: string,
): Promise<ScheduledPrompt[]> {
	const data = await request<{ prompts?: ScheduledPrompt[] }>(
		`/sessions/${encodeURIComponent(sessionId)}/scheduled-prompts`,
		{ label: "Failed to fetch scheduled prompts" },
	);
	return data?.prompts ?? [];
}

export async function createScheduledPromptApi(
	sessionId: string,
	input: { prompt: string; at: string; user: string },
): Promise<ScheduledPrompt> {
	return request(`/sessions/${encodeURIComponent(sessionId)}/scheduled-prompts`, {
		method: "POST",
		body: input,
	});
}

export async function deleteScheduledPromptApi(id: string): Promise<void> {
	await request<void>(`/scheduled-prompts/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete scheduled prompt",
	});
}
