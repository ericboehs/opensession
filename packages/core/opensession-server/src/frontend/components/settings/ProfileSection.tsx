import React, { useEffect, useRef, useState } from "react";
import {
	fetchProfile,
	removeProfileImage,
	saveProfile,
	uploadProfileImage,
	type Profile,
} from "../../lib/api/profile";
import { useIsPhone } from "../../hooks/useIsPhone";
import { refreshPeople } from "../../lib/people";
import { Button } from "../../ui/button";
import { Field, FieldGrid, Input } from "../../ui/input";
import { SettingsForm, SettingsGroupLabel } from "../../ui/settings";
import { ResponsiveDialog } from "../../ui/sheet";
import { Spinner } from "../../ui/spinner";
import { EmptyState, InlineAlert, Skeleton, SkeletonBar } from "../../ui/state";
import { toast } from "../../ui/toast";
import { IconImage, IconPencil, IconTrash } from "../icons";
import { useCurrentUser } from "../UserPicker";
import { UserAvatar } from "../UserAvatar";

/**
 * Settings > Personal > Account, first block: who you are on this instance.
 *
 * At rest it is a portrait, not a form: your picture and your name. Editing is
 * a dialog, so the page a person opens to check something is not four input
 * rectangles they have to read past (and on a phone the fields get the whole
 * screen instead of a card's width).
 *
 * The identifiers you cannot move yourself (your GitHub login, your Slack id)
 * are not listed as dead rows: the accounts below already show the GitHub one,
 * and a disabled field is not information. Aliases are gone from the form too.
 * They are matching wiring rather than profile, and the one case a person hits
 * is handled for them: renaming keeps the old short name automatically
 * (routes/profile.ts).
 */
export function ProfileSection() {
	const currentUser = useCurrentUser();
	const [profile, setProfile] = useState<Profile | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);

	useEffect(() => {
		let alive = true;
		setProfile(null);
		setLoadError(null);
		fetchProfile(currentUser)
			.then((p) => alive && setProfile(p))
			.catch((e) => alive && setLoadError(e.message));
		return () => {
			alive = false;
		};
	}, [currentUser]);

	return (
		<>
			<SettingsGroupLabel className="mt-0">Profile</SettingsGroupLabel>
			{loadError ? (
				<InlineAlert>{loadError}</InlineAlert>
			) : !profile ? (
				<ProfileSkeleton />
			) : !profile.editable ? (
				<EmptyState placement="card">
					You ({profile.user}) are not on this instance&rsquo;s roster yet. An
					admin can add you on Settings &rsaquo; Members.
				</EmptyState>
			) : (
				<ProfileCard profile={profile} onChange={setProfile} />
			)}
		</>
	);
}

/**
 * The portrait on its way: the card it lands in, the picture at the size it
 * lands at, and the name under it.
 *
 * The lines are bars rather than text-height rectangles on purpose. A grey box
 * the size of a line of type reads as a disabled control, a thing you are not
 * allowed to use, where a thin bar reads as a line about to be written. The
 * picture is the one exception, because it really is an 80px squircle and
 * drawing it smaller would move everything under it when the real one arrives.
 */
function ProfileSkeleton() {
	return (
		<Skeleton label="Loading your profile">
			<SettingsForm className="items-center gap-0 py-7">
				<SkeletonBar className="size-20 rounded-avatar" />
				<SkeletonBar className="mt-4 h-3 w-40" />
			</SettingsForm>
		</Skeleton>
	);
}

/**
 * The portrait, and the dialog behind it.
 *
 * Both live in one component because they share the picture: uploading and
 * removing happen from the dialog but change what the portrait shows, and one
 * busy flag keeps a second click from racing the first. The picture saves on
 * pick (choosing a file already is the confirmation), the fields save on Save.
 */
function ProfileCard({
	profile,
	onChange,
}: {
	profile: Profile;
	onChange: (next: Profile) => void;
}) {
	const isPhone = useIsPhone();
	const fileRef = useRef<HTMLInputElement>(null);
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(profile.name);
	const [email, setEmail] = useState(profile.email);
	const [timezone, setTimezone] = useState(profile.timezone);
	const [busy, setBusy] = useState<"picture" | "fields" | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Reset the draft whenever the dialog opens, so a Cancel really discards:
	// the fields are also re-seeded when a save lands, since that replaces the
	// profile this reads from.
	useEffect(() => {
		if (!editing) return;
		setName(profile.name);
		setEmail(profile.email);
		setTimezone(profile.timezone);
		setError(null);
	}, [editing, profile]);

	const nextShort = name.trim().split(/\s+/)[0] ?? "";
	const shortNameChanging =
		!!nextShort && nextShort.toLowerCase() !== profile.shortName.toLowerCase();
	const dirty =
		name.trim() !== profile.name ||
		email.trim() !== profile.email ||
		timezone.trim() !== profile.timezone;
	// The picture control's accessible name. A glyph on a badge says "picture"
	// but not which way it goes, and someone with no picture yet is being
	// offered a different thing than someone replacing one.
	const pictureAction = profile.image ? "Change picture" : "Upload picture";

	async function pickPicture(file: File | undefined) {
		if (!file) return;
		setError(null);
		const limitMb = Math.round(profile.imageMaxBytes / 1024 / 1024);
		if (file.size > profile.imageMaxBytes) {
			setError(
				`That picture is ${Math.round(file.size / 1024 / 1024)}MB. The limit is ${limitMb}MB.`,
			);
			return;
		}
		setBusy("picture");
		try {
			const { image } = await uploadProfileImage(file, profile.user);
			onChange({ ...profile, image });
			await refreshPeople();
			toast("Picture updated");
		} catch (e: any) {
			setError(e.message);
		} finally {
			setBusy(null);
			// Clear the input or picking the same file twice does nothing.
			if (fileRef.current) fileRef.current.value = "";
		}
	}

	async function removePicture() {
		setBusy("picture");
		setError(null);
		try {
			await removeProfileImage(profile.user);
			onChange({ ...profile, image: "" });
			await refreshPeople();
			toast("Picture removed");
		} catch (e: any) {
			setError(e.message);
		} finally {
			setBusy(null);
		}
	}

	async function submit(event: React.FormEvent) {
		event.preventDefault();
		if (!name.trim() || busy || !dirty) return;
		setBusy("fields");
		setError(null);
		try {
			const saved = await saveProfile(
				{ name: name.trim(), email: email.trim(), timezone: timezone.trim() },
				profile.user,
			);
			onChange(saved);
			await refreshPeople();
			toast(
				saved.renamedFrom
					? `Saved. You are ${saved.shortName} everywhere now.`
					: "Profile saved",
			);
			setEditing(false);
		} catch (e: any) {
			setError(e.message);
		} finally {
			setBusy(null);
		}
	}

	return (
		<>
			<input
				ref={fileRef}
				type="file"
				accept="image/png,image/jpeg,image/gif,image/webp"
				className="hidden"
				onChange={(e) => void pickPicture(e.target.files?.[0])}
			/>
			<SettingsForm className="items-center gap-0 py-7">
				{/* The whole portrait opens the editor, with the badge as the mark
				    that says so. A badge that is the only target makes a 28px hit
				    area out of a 80px one, and the picture is what the eye goes to
				    anyway. */}
				<button
					type="button"
					onClick={() => setEditing(true)}
					aria-label="Edit profile"
					className="focus-ring relative flex rounded-avatar"
				>
					<UserAvatar
						name={profile.name}
						login={profile.github}
						image={profile.image}
						size={80}
					/>
					{/* Straddling the bottom-right corner, so it marks the picture
					    without covering the face in it. Hard white rather than a
					    themed surface: it sits on whatever photo a person uploaded,
					    so it has to hold its own contrast in both themes instead of
					    following the page. Same reason its ink is hard black. */}
					<span
						className="absolute -bottom-0.5 -right-0.5 grid size-8 place-items-center rounded-full bg-white text-black shadow-sm"
						aria-hidden
					>
						{busy === "picture" ? (
							<Spinner size="sm" />
						) : (
							<IconPencil size={16} dense />
						)}
					</span>
				</button>
				{/* Your name and nothing under it. The GitHub login is already on
				    the account row below, and a timezone is a setting rather than
				    something you recognize yourself by. */}
				<div className="mt-3.5 text-item-title font-semibold text-fg">
					{profile.name}
				</div>
			</SettingsForm>
			{/* An error from the picture has to be visible when the dialog is shut,
			    since removing can be triggered from inside it and then reported
			    after it closes. */}
			{error && !editing && (
				<InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
			)}
			<ResponsiveDialog
				open={editing}
				onClose={() => setEditing(false)}
				phone={isPhone}
				label="Edit profile"
				modalClassName="w-[min(420px,calc(100vw-32px))]"
			>
				{(dismiss) => (
					<form className="flex flex-col gap-3.5 p-5" onSubmit={submit}>
						<div className="text-item-title font-semibold text-fg">
							Edit profile
						</div>
						{/* Picture actions are badges on the picture itself, both
						    always visible: hover cannot be the way in on a phone, and
						    a row of two labelled buttons under a portrait is more
						    furniture than a rarely-used action deserves. Change is a
						    picture glyph rather than a camera, because this replaces a
						    FILE rather than taking a shot; remove is a trash, because
						    it deletes one and you can put another back. */}
						<div className="relative mx-auto mb-1 mt-1 flex">
							<UserAvatar
								name={name || profile.name}
								login={profile.github}
								image={profile.image}
								size={72}
							/>
							<button
								type="button"
								disabled={busy !== null}
								onClick={() => fileRef.current?.click()}
								aria-label={pictureAction}
								title={pictureAction}
								className="focus-ring absolute -bottom-0.5 -right-0.5 grid size-7 place-items-center rounded-full bg-white text-black shadow-sm transition-colors hover:text-accent disabled:pointer-events-none"
							>
								{busy === "picture" ? (
									<Spinner size="sm" />
								) : (
									<IconImage size={15} dense />
								)}
							</button>
							{profile.image && (
								<button
									type="button"
									disabled={busy !== null}
									onClick={() => void removePicture()}
									aria-label="Remove picture"
									title="Remove picture"
									className="focus-ring absolute -right-0.5 -top-0.5 grid size-7 place-items-center rounded-full bg-white text-black shadow-sm transition-colors hover:text-red disabled:pointer-events-none"
								>
									<IconTrash size={15} dense />
								</button>
							)}
						</div>
						{/* The note is a sibling of the Field, not a child: `Field` is
						    the `<label>`, so text inside it joins the input's accessible
						    name. The wrapper gives it the gap the label already has
						    above the input, rather than the form's row gap. */}
						<div className="flex min-w-0 flex-col gap-1.5">
							<Field label="Name">
								<Input
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Ada Lovelace"
									spellCheck={false}
								/>
							</Field>
							{/* Not a warning: nothing is wrong, and the rename is handled
							    for them by routes/profile.ts, which keeps the old short
							    name as an alias and carries the per-user stores across.
							    All they need is which name their teammates will see, and
							    that the old one still finds them. */}
							{shortNameChanging && (
								<p className="m-0 text-meta text-dim">
									{profile.shortName} becomes {nextShort} in mentions and
									attribution. {profile.shortName} keeps working.
								</p>
							)}
						</div>
						<FieldGrid>
							<Field label="Email">
								<Input
									type="email"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									placeholder="ada@example.com"
									spellCheck={false}
								/>
							</Field>
							<Field label="Timezone">
								<Input
									value={timezone}
									onChange={(e) => setTimezone(e.target.value)}
									placeholder="Europe/Amsterdam"
									spellCheck={false}
									autoCapitalize="none"
								/>
							</Field>
						</FieldGrid>
						{error && (
							<InlineAlert onDismiss={() => setError(null)}>{error}</InlineAlert>
						)}
						<div className="mt-1 flex justify-end gap-2">
							<Button variant="ghost" onClick={dismiss}>
								Cancel
							</Button>
							<Button
								variant="primary"
								type="submit"
								disabled={!name.trim() || !dirty || busy !== null}
							>
								{busy === "fields" ? "Saving…" : "Save"}
							</Button>
						</div>
					</form>
				)}
			</ResponsiveDialog>
		</>
	);
}
