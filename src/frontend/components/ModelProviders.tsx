import { BASE_PATH } from "../lib/base";
import React, { useCallback, useEffect, useState } from "react";
import { toast } from "../ui/toast";

// Settings → Model providers: third-party OpenCode providers (xai, openrouter,
// groq, …) — API key + optional baseURL, stored server-side (0600, returned
// masked) — plus the model ids each one surfaces in the model picker. The
// anthropic/openai bridges are configured under Accounts, never here; the server
// rejects those ids.

interface ProviderInfo {
	id: string;
	apiKeyMasked: string;
	baseURL?: string;
	/** Full picker ids (opencode/<provider>/<model>) registered for it. */
	models: string[];
}

/** Common opencode provider slugs, offered as datalist suggestions. */
const COMMON_PROVIDER_IDS = [
	"xai",
	"meta",
	"openrouter",
	"google",
	"groq",
	"mistral",
	"deepseek",
	"cerebras",
	"fireworks",
	"together",
];

const PROVIDER_MODEL_DEFAULTS: Record<string, string> = {
	cerebras: "gpt-oss-120b, gemma-4-31b, zai-glm-4.7",
};

export function ModelProvidersPanel() {
	const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
	const [showAdd, setShowAdd] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`${BASE_PATH}/api/settings/model-providers`);
			if (res.ok) setProviders((await res.json()).providers);
		} catch {}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	async function handleRemove(p: ProviderInfo) {
		if (
			!confirm(
				`Remove provider "${p.id}"? Its API key and its ${p.models.length} picker model${
					p.models.length === 1 ? "" : "s"
				} are deleted; runs on its models will stop authenticating.`,
			)
		)
			return;
		try {
			const res = await fetch(
				`${BASE_PATH}/api/settings/model-providers/${encodeURIComponent(p.id)}`,
				{ method: "DELETE" },
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			toast(`Provider ${p.id} removed`);
			load();
		} catch (e: any) {
			toast(e.message, { variant: "error" });
		}
	}

	return (
		<div className="settings-panel">
			<h1 className="settings-title">Model providers</h1>
			<div className="setting-row-desc" style={{ marginBottom: 14 }}>
				Bring your own models: any provider the OpenCode engine supports (xAI,
				OpenRouter, Groq, Mistral, …) with your API key. Registered model ids
				show up in the model picker; runs on them authenticate with the stored
				key. Anthropic and OpenAI run on the subscription bridges — manage
				those under Accounts.
			</div>

			<div className="settings-group-label flex items-center justify-between gap-2">
				<span>Configured providers</span>
				<button className="btn-small" onClick={() => setShowAdd(true)}>
					+ Add provider
				</button>
			</div>

			{showAdd && (
				<AddProviderForm
					onClose={() => setShowAdd(false)}
					onSaved={() => {
						setShowAdd(false);
						load();
					}}
				/>
			)}

			<div className="setting-card">
				{!providers ? (
					<div className="px-4 py-3 text-dim text-[12.5px]">
						Loading providers…
					</div>
				) : providers.length === 0 ? (
					<div className="px-4 py-3 text-dim text-[12.5px]">
						No providers yet — add one to run sessions on models beyond the
						Anthropic/OpenAI subscriptions.
					</div>
				) : (
					providers.map((p) => (
						<div key={p.id} className="setting-row">
							<span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-active text-[13px] font-bold text-dim">
								{p.id.charAt(0).toUpperCase()}
							</span>
							<div className="setting-row-text">
								<div className="setting-row-title">{p.id}</div>
								<div className="setting-row-desc truncate">
									{p.apiKeyMasked ? (
										<span className="font-mono">{p.apiKeyMasked}</span>
									) : (
										"no API key stored"
									)}
									{p.baseURL && (
										<>
											{" · "}
											<span className="font-mono">{p.baseURL}</span>
										</>
									)}
								</div>
								{p.models.length > 0 ? (
									<div className="mt-1.5 flex flex-wrap gap-1">
										{p.models.map((m) => (
											<span
												key={m}
												className="rounded-sm bg-active px-1.5 py-px font-mono text-[11px] text-dim"
												title={m}
											>
												{m.split("/").slice(2).join("/")}
											</span>
										))}
									</div>
								) : (
									<div className="mt-1 text-[11.5px] text-faint">
										No picker models — its models are type-in only
										(opencode/{p.id}/&lt;model&gt;).
									</div>
								)}
							</div>
							<div className="setting-row-control">
								<button
									className="btn-small btn-small-danger"
									onClick={() => handleRemove(p)}
									title="Remove this provider and its picker models"
								>
									Remove
								</button>
							</div>
						</div>
					))
				)}
			</div>

			<div className="settings-hint">
				Keys are stored on the server (0600) and only ever shown masked.
				Changes apply to new session runs immediately, and saved models appear
				in the picker without a restart. To update a provider, add it again
				with the same id — the key, base URL and model list are replaced.
			</div>
		</div>
	);
}

function AddProviderForm({
	onClose,
	onSaved,
}: {
	onClose: () => void;
	onSaved: () => void;
}) {
	const [id, setId] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [baseURL, setBaseURL] = useState("");
	const [models, setModels] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const cleanId = id.trim().toLowerCase();
	const idValid = /^[a-z0-9-]+$/.test(cleanId);

	async function handleSave() {
		setSaving(true);
		setError(null);
		try {
			const modelIds = models
				.split(/[\s,]+/)
				.map((m) => m.trim())
				.filter(Boolean);
			const res = await fetch(
				`${BASE_PATH}/api/settings/model-providers/${encodeURIComponent(cleanId)}`,
				{
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						// Strip all whitespace — pasted keys often carry newlines.
						...(apiKey.trim() ? { apiKey: apiKey.replace(/\s+/g, "") } : {}),
						...(baseURL.trim() ? { baseURL: baseURL.trim() } : {}),
						...(modelIds.length ? { models: modelIds } : {}),
					}),
				},
			);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error || `Failed: ${res.status}`);
			toast(`Provider ${cleanId} saved`);
			onSaved();
		} catch (e: any) {
			setError(e.message);
			setSaving(false);
		}
	}

	return (
		<div className="automation-form" style={{ marginBottom: 12 }}>
			<div className="automation-form-title">Add provider</div>
			<div className="setting-row-desc" style={{ marginTop: -8 }}>
				The provider id must match opencode's slug for it (xai, openrouter,
				groq, …). Models are registered in the picker as{" "}
				<code>opencode/&lt;provider&gt;/&lt;model&gt;</code> — list the
				provider's own model ids, e.g. <code>grok-4</code> for xai.
			</div>

			<div className="automation-form-row">
				<label>
					Provider id
					<input
						value={id}
						onChange={(e) => setId(e.target.value)}
						placeholder="xai"
						list="model-provider-ids"
					/>
					<datalist id="model-provider-ids">
						{COMMON_PROVIDER_IDS.map((p) => (
							<option key={p} value={p} />
						))}
					</datalist>
				</label>
				<label>
					API key
					<input
						className="mono-input"
						type="password"
						value={apiKey}
						onChange={(e) => setApiKey(e.target.value)}
						placeholder="xai-…"
					/>
				</label>
			</div>
			<div className="automation-form-row">
				<label>
					Base URL (optional)
					<input
						className="mono-input"
						value={baseURL}
						onChange={(e) => setBaseURL(e.target.value)}
						placeholder="https://api.x.ai/v1"
					/>
				</label>
				<label>
					Model ids (optional, comma or space separated)
					<input
						className="mono-input"
						value={models}
						onChange={(e) => setModels(e.target.value)}
						placeholder={
							PROVIDER_MODEL_DEFAULTS[cleanId] || "grok-4, grok-4-mini"
						}
					/>
				</label>
			</div>

			{error && <div className="form-error">{error}</div>}

			<div className="automation-form-actions">
				<button className="btn-delete-cancel" onClick={onClose} disabled={saving}>
					Cancel
				</button>
				<button
					className="btn-create"
					style={{ padding: "8px 22px" }}
					onClick={handleSave}
					disabled={saving || !cleanId || !idValid || !apiKey.trim()}
				>
					{saving ? "Saving…" : "Save provider"}
				</button>
			</div>
		</div>
	);
}
