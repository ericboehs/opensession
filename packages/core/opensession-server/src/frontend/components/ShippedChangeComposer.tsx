import React, { useEffect, useRef, useState } from "react";
import { fetchShippedChangeChannels } from "../lib/api/shipped-changes";
import { imageFilesFromPaste, uploadFile } from "../lib/images";
import { noAutofill } from "../lib/composer-autofill";
import { Button } from "../ui/button";
import { OptionSelect } from "../ui/select";
import { toast } from "../ui/toast";
import { Tooltip } from "../ui/tooltip";
import { BrandMark } from "./BrandMark";
import { openLightbox } from "./MediaLightbox";
import { IconPlus, IconX } from "./icons";
import { Spinner } from "../ui/spinner";

const MAX_SLACK_IMAGE_BYTES = 20 * 1024 * 1024;

export interface SlackSent {
	channelName: string;
	permalink?: string;
	receiptKey?: string;
}

export function SlackSentNotice({
	channelName,
	permalink,
	onSendAnother,
}: SlackSent & { onSendAnother: () => void }) {
	return (
		<div className="mx-auto mt-2 mb-6 flex w-full max-w-[var(--session-col)] items-center gap-1.5 px-1 text-label leading-5 text-dim">
			<BrandMark name="slack" size={12} />
			<span>
				Sent to <span className="font-semibold text-fg">#{channelName}</span>
			</span>
			{permalink && (
				<>
					<span aria-hidden className="text-faint">·</span>
					<a
						className="focus-ring rounded-sm text-dim underline decoration-line underline-offset-2 transition-colors hover:text-fg hover:decoration-current"
						href={permalink}
						target="_blank"
						rel="noreferrer"
					>
						Open in Slack
					</a>
				</>
			)}
			<Button variant="ghost" size="sm" className="ml-auto phone:min-h-10" onClick={onSendAnother}>
				Send another
			</Button>
		</div>
	);
}

export interface ShippedChangeComposerProps {
	sessionId: string;
	defaultMessage: string;
	screenshot?: string;
	initialScreenshots?: string[];
	reconnectRequired?: boolean;
	status: "idle" | "sharing";
	onShare: (message: string, channel: string, screenshots: string[]) => void;
	onReconnectSlack?: () => void;
	onCancel?: () => void;
	loadChannels?: () => Promise<{
		channels: Array<{ id: string; name: string }>;
		defaultChannel?: string;
		canUploadImages?: boolean;
	}>;
	defaultChannel?: string;
	nextMessage?: string;
	sent?: SlackSent;
}

export function ShippedChangeComposer({
	sessionId,
	defaultMessage,
	screenshot,
	initialScreenshots,
	reconnectRequired = false,
	status,
	onShare,
	onReconnectSlack,
	onCancel,
	loadChannels,
	defaultChannel,
	nextMessage,
	sent,
}: ShippedChangeComposerProps) {
	const [message, setMessage] = useState(defaultMessage);
	const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
	const [channel, setChannel] = useState("");
	const [screenshots, setScreenshots] = useState<string[]>(() => [
		...(screenshot ? [screenshot] : []),
		...(initialScreenshots || []),
	].filter((path, index, all) => all.indexOf(path) === index).slice(0, 10));
	const [uploading, setUploading] = useState(false);
	const [awaitingSlack, setAwaitingSlack] = useState(false);
	const [canUploadImages, setCanUploadImages] = useState(true);
	const [composingAfterSent, setComposingAfterSent] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const sessionRef = useRef(sessionId);
	const sentKey = sent
		? `${sent.channelName}\0${sent.permalink || ""}\0${sent.receiptKey || ""}`
		: "";

	useEffect(() => {
		setMessage(defaultMessage);
		if (sessionRef.current !== sessionId) {
			sessionRef.current = sessionId;
			setScreenshots([
				...(screenshot ? [screenshot] : []),
				...(initialScreenshots || []),
			].filter((path, index, all) => all.indexOf(path) === index).slice(0, 10));
		}
	}, [defaultMessage, screenshot, initialScreenshots, sessionId]);
	useEffect(() => {
		setScreenshots((current) => screenshot && !current.includes(screenshot)
			? [screenshot, ...current]
			: current);
	}, [screenshot]);
	useEffect(() => {
		setComposingAfterSent(false);
	}, [sentKey]);
	useEffect(() => {
		if (sent && !composingAfterSent) return;
		let current = true;
		(loadChannels ? loadChannels() : fetchShippedChangeChannels(sessionId))
			.then((result) => {
				if (!current) return;
				setChannels(result.channels);
				setCanUploadImages(result.canUploadImages !== false);
				const preferred = defaultChannel || result.defaultChannel;
				setChannel(
					result.channels.some((candidate) => candidate.id === preferred || candidate.name === preferred?.replace(/^#/, ""))
						? result.channels.find((candidate) => candidate.id === preferred || candidate.name === preferred?.replace(/^#/, ""))!.id
						: result.channels[0]?.id || "",
				);
			})
			.catch(() => {
				if (current) setChannels([]);
			});
		return () => {
			current = false;
		};
	}, [sessionId, loadChannels, defaultChannel, sent, composingAfterSent]);
	const addImages = async (files: File[]) => {
		const candidates = files.filter((file) => file.type.startsWith("image/"));
		const oversized = candidates.find((file) => file.size > MAX_SLACK_IMAGE_BYTES);
		if (oversized) {
			toast(`${oversized.name} is larger than Slack's 20 MB image limit`, {
				variant: "error",
			});
		}
		const images = candidates
			.filter((file) => file.size <= MAX_SLACK_IMAGE_BYTES)
			.slice(0, 10 - screenshots.length);
		if (!images.length) return;
		setUploading(true);
		try {
			const uploaded = await Promise.all(images.map((file) => uploadFile(file)));
			setScreenshots((current) => [...new Set([
				...current,
				...uploaded.map((file) => file.path),
			])].slice(0, 10));
		} catch (error) {
			toast(error instanceof Error ? error.message : "Couldn't add that image", {
				variant: "error",
			});
		} finally {
			setUploading(false);
		}
	};
	const mediaUrl = (path: string) => path.startsWith("/media?")
		? path
		: `/media?path=${encodeURIComponent(path)}`;
	const reconnect = async () => {
		if (!onReconnectSlack) return;
		setAwaitingSlack(true);
		try {
			await onReconnectSlack();
			for (let attempt = 0; attempt < 24; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5_000));
				const result = await (loadChannels ? loadChannels() : fetchShippedChangeChannels(sessionId));
				setChannels(result.channels);
				setCanUploadImages(result.canUploadImages !== false);
				if (result.canUploadImages !== false) return;
			}
			toast("Slack access is still waiting for approval", { variant: "error" });
		} catch (error) {
			toast(error instanceof Error ? error.message : "Couldn't reconnect Slack", { variant: "error" });
		} finally {
			setAwaitingSlack(false);
		}
	};

	if (sent && !composingAfterSent) {
		return (
			<SlackSentNotice
				{...sent}
				onSendAnother={() => {
					setMessage(nextMessage?.trim().slice(0, 500) || "");
					setScreenshots([]);
					setComposingAfterSent(true);
				}}
			/>
		);
	}

	return (
		<div className="mx-auto mt-2 mb-6 w-full max-w-[var(--session-col)]">
			<div className="mb-2 flex items-center gap-1.5 px-1 text-label leading-5 text-dim">
				<BrandMark name="slack" size={12} />
				<span className="font-semibold">Send to Slack</span>
				{onCancel && (
					<Tooltip label="Close" side="bottom">
						<Button
							variant="ghost"
							size="md"
							className="ml-auto phone:size-10"
							icon={<IconX size={18} />}
							aria-label="Close"
							disabled={status !== "idle"}
							onClick={onCancel}
						/>
					</Tooltip>
				)}
			</div>
			<div
				className="rounded-[var(--composer-radius)] border border-[color:var(--composer-border)] bg-[var(--composer-surface)] px-3.5 pt-3.5 pb-2.5 shadow-[var(--composer-shadow)] transition-[border-color,box-shadow] focus-within:border-accent desktop:border-transparent desktop:[--smooth-ring-color:var(--composer-border)] desktop:smooth-shadow-ring-soft phone:px-3 phone:pt-3 phone:pb-2"
				onDragOver={(event) => event.preventDefault()}
				onDrop={(event) => {
					event.preventDefault();
					if (status === "idle") void addImages(Array.from(event.dataTransfer.files));
				}}
			>
				<textarea
					className="block min-h-14 max-h-32 w-full resize-none border-0 bg-transparent p-0 text-body leading-[1.55] text-fg outline-none [field-sizing:content] placeholder:text-faint phone:text-input-phone"
					aria-label="Slack message"
					{...noAutofill}
					value={message}
					maxLength={500}
					disabled={status !== "idle"}
					onChange={(event) => setMessage(event.target.value)}
					onPaste={(event) => {
						const files = imageFilesFromPaste(event);
						if (files.length) {
							event.preventDefault();
							void addImages(files);
						}
					}}
				/>
				{screenshots.length > 0 && (
					<div className="mt-0.5 flex gap-2 overflow-x-auto pt-2 pr-2 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
						{screenshots.map((path, index) => (
							<div key={path} className="group/image relative shrink-0">
								<button type="button" aria-label="Open screenshot preview" className="focus-ring block overflow-hidden rounded-md" onClick={(event) => openLightbox(screenshots.map((item) => ({ kind: "image", src: mediaUrl(item) })), index, event.currentTarget)}>
									<img className="h-16 w-24 rounded-md border border-line-strong object-cover object-top" src={mediaUrl(path)} alt="" />
								</button>
								<button type="button" aria-label="Remove screenshot" disabled={status !== "idle"} className="focus-ring absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full border-2 border-[color:var(--composer-surface)] bg-fg p-0 text-panel shadow-sm transition-[opacity,scale] active:scale-[0.96] disabled:opacity-50 [@media(hover:hover)]:pointer-events-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/image:pointer-events-auto [@media(hover:hover)]:group-hover/image:opacity-100 [@media(hover:hover)]:focus-visible:pointer-events-auto [@media(hover:hover)]:focus-visible:opacity-100" onClick={() => setScreenshots((current) => current.filter((_, i) => i !== index))}>
									<IconX className="block" size={14} />
								</button>
							</div>
						))}
					</div>
				)}
				<div className="mt-2.5 flex items-center gap-1.5 phone:mt-2">
					<input ref={fileInputRef} className="sr-only" type="file" accept="image/*" multiple onChange={(event) => { void addImages(Array.from(event.target.files || [])); event.currentTarget.value = ""; }} />
					<button type="button" aria-label="Add images" title="Add images" className="focus-ring inline-flex size-8 shrink-0 items-center justify-center rounded-control text-dim transition-[background-color,color,scale] hover:bg-hover hover:text-fg active:scale-[0.96] disabled:opacity-40 phone:size-10" disabled={status !== "idle" || uploading || screenshots.length >= 10} onClick={() => fileInputRef.current?.click()}>
						{uploading ? <Spinner size="md" /> : <IconPlus size={20} />}
					</button>
					<div className="flex-1" />
					{/* The app's own select. This was the native one with
					    `appearance-none`, a hand-placed chevron and a wrapper to
					    position it, which is the primitive rebuilt by hand around a
					    control it exists to replace. */}
					<OptionSelect
						label="Slack channel"
						className="w-28 phone:w-32"
						value={channel}
						options={
							channels.length === 0
								? [{ value: "", label: "No channels available" }]
								: channels.map((candidate) => ({
										value: candidate.id,
										label: `#${candidate.name}`,
									}))
						}
						onChange={setChannel}
						disabled={status !== "idle" || channels.length === 0}
					/>
					<Button variant="primary" size="md" icon={<BrandMark name="slack" size={12} />} disabled={status !== "idle" || awaitingSlack || (!(reconnectRequired || (!canUploadImages && screenshots.length > 0)) && ((!message.trim() && screenshots.length === 0) || !channel || uploading))} onClick={() => reconnectRequired || (!canUploadImages && screenshots.length > 0) ? void reconnect() : onShare(message.trim(), channel, screenshots)}>
						{awaitingSlack ? "Waiting…" : reconnectRequired || (!canUploadImages && screenshots.length > 0) ? "Reconnect" : status === "sharing" ? "Sending…" : "Send"}
					</Button>
				</div>
			</div>
		</div>
	);
}
