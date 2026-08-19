import React, { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Field, FieldGrid, Input } from "../ui/input";
import { MENU_ICON, Menu } from "../ui/menu";
import { Modal } from "../ui/modal";
import { EmptyState, InlineAlert } from "../ui/state";
import {
	rowMenuTriggerClasses,
	SettingCard,
	SettingCardSkeleton,
	SettingRow,
	SettingRowControl,
	SettingRowDescription,
	SettingRowText,
	SettingRowTitle,
	SettingsGroupLabel,
	SettingsHint,
} from "../ui/settings";
import { toast } from "../ui/toast";
import { IconDotsHorizontal, IconPencil, IconPlus, IconTrash } from "./icons";
import { setupRequest, type TeamMember } from "./setup-shared";
import { UserAvatar } from "./UserAvatar";

// Settings → Setup → Team: the manageable roster. The identity table drives
// commit attribution, `allowedUsers` MCP scoping, and GitHub sign-in, so each
// member row stays concise while every identifier remains available in the
// edit dialog. Add/edit go through a small dialog; remove is confirmed.

export function TeamSection({
	onChanged,
	title,
}: {
	onChanged: () => void | Promise<void>;
	/** Optional label above the roster. Defaults to the roster name and count. */
	title?: React.ReactNode;
}) {
	const [members, setMembers] = useState<TeamMember[] | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [editing, setEditing] = useState<TeamMember | null>(null);

	const load = useCallback(async () => {
		try {
			const body = await setupRequest<{ members: TeamMember[] }>("/api/setup/team");
			setMembers(body.members);
			setLoadFailed(false);
		} catch {
			setLoadFailed(true);
		}
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	async function handleMutated() {
		await load();
		await onChanged();
	}

	return (
		<>
			<SettingsGroupLabel
				className={title ? undefined : "mt-0"}
				actions={
					<Button
						size="sm"
						icon={<IconPlus size={16} />}
						onClick={() => {
							setEditing(null);
							setDialogOpen(true);
						}}
					>
						Add member
					</Button>
				}
			>
				{title ?? `Team members${members ? ` · ${members.length}` : ""}`}
			</SettingsGroupLabel>
			{!members && !loadFailed ? (
				// The card itself is the ghost, so the roster lands in the block it
				// was already occupying. Rendering the real card around a loading
				// label instead gave the group a one-line height that trebled the
				// moment the members arrived.
				<SettingCardSkeleton rows={3} icon={28} label="Loading team" />
			) : (
				<SettingCard>
					{!members ? (
						<EmptyState placement="row">Couldn&rsquo;t load the team roster.</EmptyState>
					) : members.length === 0 ? (
						<EmptyState placement="row">
							No teammates yet. Add everyone who uses this instance so commits and
							sessions attribute to real people.
						</EmptyState>
					) : (
						members.map((m) => (
							<MemberRow
								key={m.name}
								member={m}
								onEdit={() => {
									setEditing(m);
									setDialogOpen(true);
								}}
								onRemoved={handleMutated}
							/>
						))
					)}
				</SettingCard>
			)}
			<SettingsHint>
				Names, emails, GitHub logins and Slack ids all resolve through the same
				identity table, so a session user given as any of them matches the member.
			</SettingsHint>
			<MemberDialog
				open={dialogOpen}
				member={editing}
				onOpenChange={setDialogOpen}
				onSaved={async () => {
					setDialogOpen(false);
					await handleMutated();
				}}
			/>
		</>
	);
}

function MemberRow({
	member,
	onEdit,
	onRemoved,
}: {
	member: TeamMember;
	onEdit: () => void;
	onRemoved: () => void | Promise<void>;
}) {
	const details = [
		member.email,
		member.github && `@${member.github}`,
	].filter(Boolean);
	return (
		<SettingRow>
			<UserAvatar name={member.name} login={member.github} size={28} />
			<SettingRowText>
				<SettingRowTitle>{member.name}</SettingRowTitle>
				{details.length > 0 && (
					<SettingRowDescription className="truncate">
						{details.join(" · ")}
					</SettingRowDescription>
				)}
			</SettingRowText>
			<SettingRowControl>
				<MemberActions member={member} onEdit={onEdit} onRemoved={onRemoved} />
			</SettingRowControl>
		</SettingRow>
	);
}

function MemberActions({
	member,
	onEdit,
	onRemoved,
}: {
	member: TeamMember;
	onEdit: () => void;
	onRemoved: () => void | Promise<void>;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const cancelRef = useRef<HTMLButtonElement>(null);

	async function remove() {
		setBusy(true);
		try {
			await setupRequest(`/api/setup/team/${encodeURIComponent(member.name)}/remove`, {
				method: "POST",
			});
			toast(`${member.name} removed`);
			await onRemoved();
		} catch (e: any) {
			toast(e.message, { variant: "error" });
			setBusy(false);
		}
	}

	return (
		<>
			<Menu.Root>
				<Menu.Trigger
					className={rowMenuTriggerClasses}
					aria-label={`Manage ${member.name}`}
				>
					<IconDotsHorizontal size={18} />
				</Menu.Trigger>
				<Menu.Popup align="end" sideOffset={4}>
					<Menu.Item onClick={onEdit}>
						<IconPencil size={16} className={MENU_ICON} />
						Edit member
					</Menu.Item>
					<Menu.Item
						className="text-red data-[highlighted]:bg-red-soft data-[highlighted]:text-red"
						onClick={() => setConfirmOpen(true)}
					>
						<IconTrash size={16} />
						Remove member
					</Menu.Item>
				</Menu.Popup>
			</Menu.Root>
			<Modal.Root
				open={confirmOpen}
				onOpenChange={(open) => {
					if (!busy) setConfirmOpen(open);
				}}
				disablePointerDismissal={busy}
			>
				<Modal.Content initialFocus={cancelRef}>
					<Modal.Header
						title={`Remove ${member.name}?`}
						description="This removes their identity mapping from Open Session."
					/>
					<Modal.Footer>
						<Button
							ref={cancelRef}
							variant="ghost"
							onClick={() => setConfirmOpen(false)}
							disabled={busy}
						>
							Cancel
						</Button>
						<Button variant="danger-strong" onClick={remove} disabled={busy}>
							{busy ? "Removing…" : "Remove"}
						</Button>
					</Modal.Footer>
				</Modal.Content>
			</Modal.Root>
		</>
	);
}

function MemberDialog({
	open,
	member,
	onOpenChange,
	onSaved,
}: {
	open: boolean;
	/** null → add; a member → edit that member. */
	member: TeamMember | null;
	onOpenChange: (open: boolean) => void;
	onSaved: () => void | Promise<void>;
}) {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [github, setGithub] = useState("");
	const [slackId, setSlackId] = useState("");
	const [alias, setAlias] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const nameRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		setError(null);
		setName(member?.name ?? "");
		setEmail(member?.email ?? "");
		setGithub(member?.github ?? "");
		setSlackId(member?.slackId ?? "");
		setAlias(member?.aliases?.join(", ") ?? "");
	}, [open, member]);

	const parsedAliases = alias
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		const trimmed = name.trim();
		if (!trimmed || saving) return;
		setSaving(true);
		setError(null);
		try {
			if (!member) {
				const body: Record<string, unknown> = { name: trimmed };
				if (email.trim()) body.email = email.trim();
				if (github.trim()) body.github = github.trim();
				if (slackId.trim()) body.slackId = slackId.trim();
				if (parsedAliases.length) body.aliases = parsedAliases;
				await setupRequest("/api/setup/team", { method: "POST", json: body });
				toast(`${trimmed} added`);
			} else {
				// Partial update: only changed fields ride; an emptied field that was
				// set is deleted with null; a changed name renames.
				const patch: Record<string, unknown> = {};
				if (trimmed !== member.name) patch.name = trimmed;
				const diffField = (key: string, next: string, prev: string | undefined) => {
					const v = next.trim();
					if (v) {
						if (v !== (prev ?? "")) patch[key] = v;
					} else if (prev) {
						patch[key] = null;
					}
				};
				diffField("email", email, member.email);
				diffField("github", github, member.github);
				diffField("slackId", slackId, member.slackId);
				const prevAliases = member.aliases ?? [];
				if (JSON.stringify(parsedAliases) !== JSON.stringify(prevAliases)) {
					patch.aliases = parsedAliases.length ? parsedAliases : null;
				}
				if (Object.keys(patch).length > 0) {
					await setupRequest(`/api/setup/team/${encodeURIComponent(member.name)}`, {
						method: "PUT",
						json: patch,
					});
				}
				toast(`${trimmed} saved`);
			}
			setSaving(false);
			await onSaved();
		} catch (e: any) {
			setError(e.message);
			setSaving(false);
		}
	}

	return (
		<Modal.Root
			open={open}
			onOpenChange={(next) => {
				if (!saving) onOpenChange(next);
			}}
			disablePointerDismissal={saving}
		>
			<Modal.Content initialFocus={nameRef}>
				<Modal.Header
					title={member ? `Edit ${member.name}` : "Add member"}
					description="Identity table entry. Commits, sessions and access grants resolve through it."
				/>
				<form className="flex flex-col gap-3" onSubmit={submit}>
					<Field label="Full name">
						<Input
							ref={nameRef}
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Ada Lovelace"
							spellCheck={false}
						/>
					</Field>
					{/* Email and Alias run full width: an address clips in a
					    half-dialog column, and an alias list grows. Only the two
					    short identifiers share a row. */}
					<Field label="Email">
						<Input
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							placeholder="ada@example.com"
							spellCheck={false}
						/>
					</Field>
					<FieldGrid>
						<Field label="GitHub login">
							<Input
								value={github}
								onChange={(e) => setGithub(e.target.value)}
								placeholder="adalovelace"
								autoCapitalize="none"
								spellCheck={false}
							/>
						</Field>
						<Field label="Slack member id">
							<Input
								className="font-mono"
								value={slackId}
								onChange={(e) => setSlackId(e.target.value)}
								placeholder="U01ABCDEF"
								autoCapitalize="none"
								spellCheck={false}
							/>
						</Field>
					</FieldGrid>
					<Field label="Alias">
						<Input
							value={alias}
							onChange={(e) => setAlias(e.target.value)}
							placeholder="ada"
							autoCapitalize="none"
							spellCheck={false}
						/>
					</Field>
					{error && <InlineAlert>{error}</InlineAlert>}
					<Modal.Footer>
						<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
							Cancel
						</Button>
						<Button variant="primary" type="submit" disabled={!name.trim() || saving}>
							{saving ? "Saving…" : member ? "Save changes" : "Add member"}
						</Button>
					</Modal.Footer>
				</form>
			</Modal.Content>
		</Modal.Root>
	);
}
