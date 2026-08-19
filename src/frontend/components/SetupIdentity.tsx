import React, { useEffect, useState } from "react";
import {
	fetchInstanceIdentity,
	saveInstanceIdentity,
	type InstanceIdentityDto,
} from "../lib/api";
import { AGENT_NAME, PRODUCT_NAME } from "../lib/brand";
import { cn } from "../ui/cn";
import {
	SettingCard,
	SettingRow,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsHint,
	settingsInputClass,
} from "../ui/settings";
import { toast } from "../ui/toast";
import { Code } from "./setup-shared";

// What this instance and its agent are called: a Setup step and a group in
// Workspace > General, rendered from the same card.

const IDENTITY_INPUT_CLASS = cn(settingsInputClass, "w-[140px]");

/** One identity field: saves on blur or Enter, reverts on Escape or failure. */
function IdentityInput({
	label,
	value,
	placeholder,
	onSave,
}: {
	label: string;
	value: string;
	placeholder: string;
	onSave: (next: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState(value);
	const [saving, setSaving] = useState(false);
	useEffect(() => setDraft(value), [value]);
	const commit = async () => {
		const next = draft.trim();
		if (saving) return;
		if (next === value) {
			setDraft(value);
			return;
		}
		setSaving(true);
		try {
			await onSave(next);
		} catch {
			setDraft(value);
		} finally {
			setSaving(false);
		}
	};
	return (
		<input
			className={IDENTITY_INPUT_CLASS}
			value={draft}
			disabled={saving}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				else if (e.key === "Escape") setDraft(value);
			}}
			placeholder={placeholder}
			aria-label={label}
		/>
	);
}

export function IdentityCard() {
	const [identity, setIdentity] = useState<InstanceIdentityDto | null>(null);
	useEffect(() => {
		let cancelled = false;
		fetchInstanceIdentity()
			.then((dto) => {
				if (!cancelled) setIdentity(dto);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	const save = async (patch: { personaName?: string; productName?: string }) => {
		try {
			setIdentity(await saveInstanceIdentity(patch));
			toast("Saved. Open tabs update after the next rebuild.", {
				variant: "success",
			});
		} catch (e: any) {
			toast(e?.message || "Failed to save", { variant: "error" });
			throw e;
		}
	};

	return (
		<>
			<SettingCard>
				<SettingRow>
					<SettingRowText>
						<SettingRowTitle>Agent name</SettingRowTitle>
						<SettingRowDescription>
							What the agent calls itself in prompts, Slack messages, and the
							UI. Stored as <Code>persona.name</Code> in{" "}
							<Code>~/.opensession/config.json</Code> on the server.
						</SettingRowDescription>
					</SettingRowText>
					<IdentityInput
						label="Agent name"
						value={identity?.personaName ?? AGENT_NAME}
						placeholder="Assistant"
						onSave={(next) => save({ personaName: next })}
					/>
				</SettingRow>
				<SettingRow>
					<SettingRowText>
						<SettingRowTitle>Product name</SettingRowTitle>
						<SettingRowDescription>
							What this app calls itself in titles and headers. Stored as{" "}
							<Code>branding.productName</Code> in the same config file.
						</SettingRowDescription>
					</SettingRowText>
					<IdentityInput
						label="Product name"
						value={identity?.productName ?? PRODUCT_NAME}
						placeholder="Open Session"
						onSave={(next) => save({ productName: next })}
					/>
				</SettingRow>
			</SettingCard>
			<SettingsHint>
				Workspace-wide, shared by everyone on this instance. Changes apply to
				new agent runs immediately; clearing a field restores the built-in
				default.
			</SettingsHint>
		</>
	);
}
