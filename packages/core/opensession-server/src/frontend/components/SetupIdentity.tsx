import React, { useEffect, useState } from "react";
import {
	fetchInstanceIdentity,
	saveInstanceIdentity,
	type InstanceIdentityDto,
} from "../lib/api";
import { AGENT_NAME, PRODUCT_NAME } from "../lib/brand";
import { cn } from "../ui/cn";
import {
	SettingRow,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	settingsInputClass,
} from "../ui/settings";
import { toast } from "../ui/toast";

// What this instance and its agent are called. These rows sit inside the
// organization card, so Setup and Workspace > General both show one section.

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
		await (async () => {
await onSave(next);
})().catch(async () => {
setDraft(value);
}).finally(async () => {
setSaving(false);
});
	};
	return (
		<input
			className={IDENTITY_INPUT_CLASS}
			// data-setup-field: FirstMile's onboarding wrapper widens these fields
			// past their settings-page width; settings ignores the attribute.
			data-setup-field="identity"
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

/** The instance's own names, as rows. They live inside the organization card
 *  so setup and settings show one section rather than two near-identical ones. */
export function IdentityRows() {
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
		await (async () => {
setIdentity(await saveInstanceIdentity(patch));
			toast("Saved. Open tabs update after the next rebuild.", {
				variant: "success",
			});
})().catch(async (e: any) => {
toast(e?.message || "Failed to save", { variant: "error" });
			throw e;
});
	};

	return (
		<>
			<SettingRow>
				<SettingRowText>
					<SettingRowTitle>Agent name</SettingRowTitle>
					<SettingRowDescription>
						Shown in prompts, Slack messages, and the app.
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
						Shown in titles and headings.
					</SettingRowDescription>
				</SettingRowText>
				<IdentityInput
					label="Product name"
					value={identity?.productName ?? PRODUCT_NAME}
					placeholder="Open Session"
					onSave={(next) => save({ productName: next })}
				/>
			</SettingRow>
		</>
	);
}
