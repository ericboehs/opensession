import { useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import markAsset from "../mac/build/icon-512.png";
import nativeMarkAsset from "../ios/OS1/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png";
import {
	IconBranches,
	IconCheck,
	IconClock,
	IconCopy,
	IconGlobe,
	IconPeople,
	IconPhone,
	IconPullRequest,
	IconRepo,
	IconRobot,
	IconServer,
	IconSparkle,
	IconStack,
	IconTerminal,
	IconX,
} from "../../core/opensession-server/src/frontend/components/icons";
import "./site.css";
import { AgentationFeedback } from "./AgentationFeedback";
import { ProductDemo } from "./ProductDemo";
import { TellaBackground } from "./TellaBackground";
import { assetUrl } from "./asset-url";

const markUrl = assetUrl(markAsset);
const nativeMarkUrl = assetUrl(nativeMarkAsset);
const macDownloadUrl =
	"https://github.com/tellahq/opensession/releases/download/v0.4.22/OpenSession-0.4.22-arm64.dmg";
const installCommandLines = [
	"curl -fsSL https://raw.githubusercontent.com",
	"/tellahq/opensession/main/install.sh | bash",
] as const;
const installCommand = installCommandLines.join("");

function Mark() {
	return (
		<span className="mark">
			<img src={markUrl} alt="" />
		</span>
	);
}

function AppleMark({ size = 16 }: { size?: number }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11Z" />
		</svg>
	);
}

/**
 * One cell of the capability grid: a glyph, a name, and what it means. A cell
 * marked `soon` describes something that is not shipped yet, so the tag sits
 * on the name where nobody can read the sentence without it.
 */
function Feature({
	icon,
	name,
	soon,
	children,
}: {
	icon: ReactNode;
	name: string;
	soon?: boolean;
	children: ReactNode;
}) {
	return (
		<div className="feature">
			<span className="feature-icon" aria-hidden="true">
				{icon}
			</span>
			<div className="feature-head">
				<h3>{name}</h3>
				{soon && <span className="feature-soon">Coming soon</span>}
			</div>
			<p>{children}</p>
		</div>
	);
}

function Question({ q, children }: { q: string; children: ReactNode }) {
	return (
		<details className="faq-item">
			<summary>
				{q}
				<span className="faq-sign" aria-hidden="true" />
			</summary>
			<p>{children}</p>
		</details>
	);
}

function PwaGuide() {
	const dialogRef = useRef<HTMLDialogElement>(null);

	return (
		<>
			<button
				type="button"
				className="landing-setup-app"
				onClick={() => dialogRef.current?.showModal()}
			>
				<span className="landing-setup-app-mark landing-setup-app-mark-web" aria-hidden="true">
					<IconGlobe size={24} />
				</span>
				<span className="landing-setup-app-copy">
					<strong>PWA</strong>
					<small>Install from your browser</small>
				</span>
				<span className="landing-setup-app-action">How to install</span>
			</button>

			<dialog
				ref={dialogRef}
				className="pwa-guide"
				aria-labelledby="pwa-guide-title"
				onClick={(event) => {
					if (event.target === event.currentTarget) event.currentTarget.close();
				}}
			>
				<div className="pwa-guide-panel">
					<button
						type="button"
						className="pwa-guide-close"
						aria-label="Close"
						onClick={() => dialogRef.current?.close()}
					>
						<IconX size={20} />
					</button>
					<span className="pwa-guide-mark" aria-hidden="true">
						<IconGlobe size={26} />
					</span>
					<h2 id="pwa-guide-title">Install the PWA</h2>
					<p>Open your HTTPS Open Session address in a browser, then:</p>
					<div className="pwa-guide-options">
						<div>
							<strong>Mac or PC</strong>
							<span>
								In Chrome or Edge, select the install icon in the address bar.
								In Safari, choose File → Add to Dock.
							</span>
						</div>
						<div>
							<strong>iPhone or iPad</strong>
							<span>
								In Safari, tap Share, then Add to Home Screen and Add.
							</span>
						</div>
					</div>
					<p className="pwa-guide-note">
						Want a standalone Electron app instead? Download the Mac app.
					</p>
				</div>
			</dialog>
		</>
	);
}

function SetupGuide({
	triggerLabel,
	title,
	description,
	secondary = false,
	children,
}: {
	triggerLabel: string;
	title: string;
	description: string;
	secondary?: boolean;
	children: ReactNode;
}) {
	const dialogRef = useRef<HTMLDialogElement>(null);
	const titleId = `setup-guide-${title.toLowerCase().replaceAll(" ", "-")}`;

	return (
		<>
			<button
				type="button"
				className={`landing-setup-step-action${secondary ? " landing-setup-step-action-secondary" : ""}`}
				onClick={() => dialogRef.current?.showModal()}
			>
				{triggerLabel}
			</button>
			<dialog
				ref={dialogRef}
				className="pwa-guide setup-guide"
				aria-labelledby={titleId}
				onClick={(event) => {
					if (event.target === event.currentTarget) event.currentTarget.close();
				}}
			>
				<div className="pwa-guide-panel">
					<button
						type="button"
						className="pwa-guide-close"
						aria-label="Close"
						onClick={() => dialogRef.current?.close()}
					>
						<IconX size={20} />
					</button>
					<h2 id={titleId}>{title}</h2>
					<p>{description}</p>
					{children}
				</div>
			</dialog>
		</>
	);
}

function InstallCommand() {
	const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
		"idle",
	);

	useEffect(() => {
		if (copyState === "idle") return;
		const timeout = window.setTimeout(() => setCopyState("idle"), 2000);
		return () => window.clearTimeout(timeout);
	}, [copyState]);

	const copyLabel =
		copyState === "copied"
			? "Copied"
			: copyState === "failed"
				? "Try again"
				: "Copy";

	return (
		<div className="landing-install-command">
			<code>
				{installCommandLines[0]}
				<wbr />
				{installCommandLines[1]}
			</code>
			<button
				type="button"
				onClick={async () => {
				try {
					await navigator.clipboard.writeText(installCommand);
					setCopyState("copied");
				} catch {
					setCopyState("failed");
				}
			}}
			>
				{copyState === "copied" ? (
					<IconCheck size={16} />
				) : (
					<IconCopy size={16} />
				)}
				<span aria-live="polite">{copyLabel}</span>
			</button>
		</div>
	);
}

function SetupOverview() {
	return (
		<section className="card landing-setup-overview">
			<h2>Set up is easy</h2>

			<ol className="landing-setup-steps">
				<li>
					<span className="landing-setup-step-icon" aria-hidden="true">
						<IconServer size={22} />
					</span>
					<div className="landing-setup-step-copy">
						<strong>
							<span aria-hidden="true">1. </span>Get a server
						</strong>
						<span>
							Use a machine (VPS, Hetzner, or Mac mini) you can leave powered on
							and connected.
						</span>
					</div>
					<SetupGuide
						triggerLabel="Run installer"
						title="Install Open Session"
						description="Run one command on Linux, macOS, or WSL2."
						secondary
					>
						<InstallCommand />
					</SetupGuide>
				</li>
				<li>
					<span className="landing-setup-step-icon" aria-hidden="true">
						<IconGlobe size={22} />
					</span>
					<div className="landing-setup-step-copy">
						<strong>
							<span aria-hidden="true">2. </span>Expose it safely
						</strong>
						<span>
							Use a Tailscale network to connect from phone or share Open Session with
							your team.
						</span>
					</div>
					<a
						className="landing-setup-step-action landing-setup-step-action-secondary"
						href="https://tailscale.com/download"
						target="_blank"
						rel="noreferrer"
					>
						Install Tailscale
					</a>
				</li>
				<li>
					<span className="landing-setup-step-icon" aria-hidden="true">
						<IconPhone size={22} />
					</span>
					<div className="landing-setup-step-copy">
						<strong>
							<span aria-hidden="true">3. </span>Download the apps
						</strong>
						<span>Each app connects to the server you just installed.</span>
					</div>
					<SetupGuide
						triggerLabel="Download apps"
						title="Download the apps"
						description="Choose how you want to connect to your Open Session server."
					>
						<div className="landing-setup-apps">
							<a className="landing-setup-app" href={macDownloadUrl}>
								<img src={markUrl} alt="" />
								<span className="landing-setup-app-copy">
									<strong>Mac app</strong>
									<small>Electron · Apple silicon</small>
								</span>
								<span className="landing-setup-app-action landing-setup-app-download">
									<AppleMark />
									Download
								</span>
							</a>
							<PwaGuide />
							<div className="landing-setup-app" aria-disabled="true">
								<img src={nativeMarkUrl} alt="" />
								<span className="landing-setup-app-copy">
									<strong>iOS app</strong>
									<small>Native app · App Store</small>
								</span>
								<span className="landing-setup-app-action">Coming soon</span>
							</div>
						</div>
					</SetupGuide>
				</li>
			</ol>
		</section>
	);
}

/**
 * The page: a rail that stays put, and a feed that explains the product one
 * quiet card at a time. The rail holds the whole pitch and the only CTA, so
 * the ask never scrolls away and the feed never has to repeat it.
 */
function LandingPage() {
	return (
		<div className="shell">
			<aside className="rail">
				<a className="brand" href="/" aria-label="Open Session home">
					<Mark />
				</a>

				<h1>
					Your team’s control room{" "}
					<span>for coding agents</span>
				</h1>

				<div className="rail-foot">
					<a
						className="button button-primary"
						href="https://github.com/tellahq/opensession"
					>
						View on GitHub
					</a>
					<p className="rail-note">
						Open source. Self-hosted. Any model provider.
					</p>
				</div>
			</aside>

			<main className="feed">
				<section className="stage">
					<div className="gradient-fallback" aria-hidden="true" />
					<TellaBackground />
					<ProductDemo />
				</section>

				<section className="card">
					<div className="features">
						<Feature icon={<IconSparkle size={28} />} name="Any model">
							Point a session at whatever model suits the work, and change it
							mid-run without losing the thread.
						</Feature>
						<Feature icon={<IconPeople size={28} />} name="Multiplayer by default">
							Anyone on the team opens the same session, sees the run as it
							happens, and sends the next turn.
						</Feature>
						<Feature icon={<IconGlobe size={28} />} name="On your machines">
							Self-hosted from the first minute. The checkouts, the transcripts
							and the keys stay on hardware you run.
						</Feature>
						<Feature icon={<IconBranches size={28} />} name="A worktree each">
							Every session gets its own branch and checkout, so ten agents work
							at once without stepping on each other.
						</Feature>
						<Feature icon={<IconPullRequest size={28} />} name="Ends in a pull request">
							Read the diff, then open the PR from the same place the work
							happened. Review stays next to the transcript.
						</Feature>
						<Feature icon={<IconRobot size={28} />} name="Agents that delegate">
							A session hands focused work to its own sub-agents and keeps their
							noise out of the conversation you are reading.
						</Feature>
						<Feature icon={<IconClock size={28} />} name="Runs without you">
							Schedules, webhooks and watched channels start sessions on their
							own, each scoped to the tools it is allowed.
						</Feature>
						<Feature icon={<IconTerminal size={28} />} name="Shells and previews">
							Open a terminal in the worktree, or a running preview of the
							branch, beside the session that built it.
						</Feature>
						<Feature icon={<IconStack size={28} />} name="Everywhere you are">
							A web app, a Mac app and a browser side panel, all on one server.
						</Feature>
						<Feature icon={<IconPhone size={28} />} name="Works on mobile">
							Read a session, answer a question and send the next turn from your
							phone. Native iOS coming soon.
						</Feature>
						<Feature icon={<IconRepo size={28} />} name="Open source">
							Read it, fork it, run it. There is no hosted tier in the path that
							you have to take on trust.
						</Feature>
					</div>
				</section>

				<SetupOverview />

				<section className="card">
					<h2>Common questions</h2>
					<div className="faq">
						<Question q="Is it really self-hosted?">
							Yes. You run the server and the agents run against your checkouts
							on your hardware. There is no Open Session cloud in the path.
						</Question>
						<Question q="Which agents can it run?">
							Whatever the engine supports. A session names a model rather than a
							vendor, and you can change that model between turns.
						</Question>
						<Question q="What does multiplayer actually mean?">
							One session, many people. The transcript updates live for everyone
							watching, you can see who else is there, and anyone can send the
							next turn or answer a question the agent asked.
						</Question>
						<Question q="Do parallel agents share a checkout?">
							No. Each session gets its own git worktree and branch. A session
							can attach a second repository when the work spans more than one.
						</Question>
						<Question q="How does the work get reviewed?">
							As a pull request on the session's branch, with the diff and the
							review beside the transcript that produced them.
						</Question>
						<Question q="Can it run when nobody is watching?">
							Yes. An automation starts a session on a schedule, a webhook or a
							message in a watched channel, with its own allowlist of tools and
							read-only access unless you grant more.
						</Question>
						<Question q="When can I use it?">
							You can use it now. Get started on GitHub and run Open Session on
							your own infrastructure.
						</Question>
					</div>
				</section>

				<footer className="feed-foot">
					<span>©2026</span>
				</footer>
			</main>
		</div>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing landing page root");

createRoot(root).render(
	<>
		<LandingPage />
		<AgentationFeedback />
	</>,
);
