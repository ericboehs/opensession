import { useEffect, useState, type ReactNode } from "react";
import macPreview from "../download-mac.webp";
import phonePreview from "../download-phone.webp";
import { useIsPhone } from "../hooks/useIsPhone";
import { BASE_PATH } from "../lib/base";
import { Button } from "../ui/button";
import { ResponsiveDialog } from "../ui/sheet";
import { IconArrowDown, IconChevronLeft, IconX } from "./icons";

export function DownloadAppsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const phone = useIsPhone();
	const [showInstallHelp, setShowInstallHelp] = useState(false);

	useEffect(() => {
		if (!open) setShowInstallHelp(false);
	}, [open]);

	return (
		<ResponsiveDialog
			open={open}
			onClose={() => onOpenChange(false)}
			phone={phone}
			label="Download apps"
			backdropClassName="bg-black/25 backdrop-blur-[1px]"
			modalClassName="w-[calc(100vw-4rem)] max-w-[75rem] max-h-[calc(100dvh-4rem)] rounded-2xl bg-raised p-10"
			sheetClassName="max-h-[92dvh] bg-raised"
		>
			<div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-5 pt-2 desktop:overflow-visible desktop:p-0">
				<header className="mb-6 flex shrink-0 items-center justify-between gap-4 desktop:mb-8">
					<div className="flex min-w-0 items-center gap-1">
						{showInstallHelp && (
							<Button
								variant="ghost"
								size="lg"
								icon={<IconChevronLeft size={22} />}
								className="size-11 shrink-0"
								onClick={() => setShowInstallHelp(false)}
								aria-label="Back to apps"
							/>
						)}
						<h2 className="m-0 truncate text-page-title font-semibold leading-tight tracking-[-0.02em] text-fg">
							{showInstallHelp ? "Install the web app" : "Download apps"}
						</h2>
					</div>
					<Button
						variant="soft"
						size="lg"
						icon={<IconX size={22} />}
						className="size-11 shrink-0 rounded-full text-faint"
						onClick={() => onOpenChange(false)}
						aria-label="Close"
					/>
				</header>

				{showInstallHelp ? (
					<div className="grid min-h-0 flex-1 gap-3 desktop:grid-cols-3">
						<InstallStep number="1" title="Open in your browser">
							Use Safari on iPhone or iPad, or Chrome on Android and desktop.
						</InstallStep>
						<InstallStep number="2" title="Open the browser menu">
							On iPhone or iPad, tap Share. Elsewhere, open the browser menu.
						</InstallStep>
						<InstallStep number="3" title="Add Open Session">
							Choose Add to Home Screen, Install app, or Add to Dock.
						</InstallStep>
					</div>
				) : (
					<div className="grid min-h-0 flex-1 gap-4 desktop:grid-cols-[3fr_2fr] desktop:gap-6">
						<AppCard
							preview={
								<div className="relative h-full overflow-hidden bg-blue-soft">
									<img
										src={macPreview}
										alt="Open Session running on Mac"
										className="h-full w-full object-cover object-top"
									/>
									<div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-b from-transparent to-panel" />
								</div>
							}
							title="Open Session for Mac"
							subtitle="Apple silicon"
						>
							<Button
								variant="primary"
								size="lg"
								icon={<IconArrowDown size={20} />}
								className="min-h-12 w-full"
								render={
									<a
										href={`${BASE_PATH}/api/packages/clients/mac/download/latest.dmg`}
									/>
								}
							>
								Download
							</Button>
						</AppCard>

						<AppCard
							preview={
								<div className="relative flex h-full justify-center overflow-hidden bg-green-soft px-5 pt-5">
									<img
										src={phonePreview}
										alt="Open Session installed as a phone web app"
										className="h-full w-auto max-w-full object-contain object-top smooth-shadow-lg"
									/>
									<div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-b from-transparent to-panel" />
								</div>
							}
							title="Web"
							subtitle="Install as a PWA"
						>
							<Button
								variant="soft"
								size="lg"
								className="min-h-12 w-full"
								onClick={() => setShowInstallHelp(true)}
							>
								How to install
							</Button>
						</AppCard>
					</div>
				)}
			</div>
		</ResponsiveDialog>
	);
}

function AppCard({
	preview,
	title,
	subtitle,
	children,
}: {
	preview: ReactNode;
	title: string;
	subtitle: string;
	children: ReactNode;
}) {
	return (
		<section className="flex min-h-[24rem] flex-col overflow-hidden rounded-xl bg-panel desktop:min-h-[31rem]">
			<div className="min-h-0 flex-1">{preview}</div>
			<div className="relative z-10 flex shrink-0 flex-col px-5 pb-5 desktop:px-7 desktop:pb-7">
				<h3 className="m-0 text-section-title font-semibold leading-tight text-fg">{title}</h3>
				<p className="mb-5 mt-1 text-body font-medium text-dim">{subtitle}</p>
				{children}
			</div>
		</section>
	);
}

function InstallStep({
	number,
	title,
	children,
}: {
	number: string;
	title: string;
	children: ReactNode;
}) {
	return (
		<section className="flex min-h-48 flex-col rounded-xl bg-panel p-5 desktop:min-h-72 desktop:p-7">
			<div className="mb-auto flex size-10 items-center justify-center rounded-control bg-accent text-body font-semibold text-on-accent">
				{number}
			</div>
			<h3 className="mb-1 mt-6 text-section-title font-semibold leading-tight text-fg">{title}</h3>
			<p className="m-0 text-body font-normal leading-relaxed text-dim">{children}</p>
		</section>
	);
}
