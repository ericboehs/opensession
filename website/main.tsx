import React, { Suspense, lazy, useState } from "react";
import { createRoot } from "react-dom/client";
import markUrl from "../os1-mac/build/icon-512.png";
import {
	IconBranches,
	IconCheck,
	IconCopy,
	IconPullRequest,
	IconRepo,
	IconSparkle,
	IconStack,
	IconTerminal,
} from "../src/frontend/components/icons";
import "./site.css";

const TellaBackground = lazy(() =>
	import("./TellaBackground").then((module) => ({
		default: module.TellaBackground,
	})),
);

const installCommand =
	"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash";

function Mark({ small = false }: { small?: boolean }) {
	return (
		<span className={small ? "mark mark-small" : "mark"}>
			<img src={markUrl} alt="" />
		</span>
	);
}

function Avatar({ name, tone }: { name: string; tone: string }) {
	return (
		<span className={`avatar avatar-${tone}`} title={name} aria-label={name}>
			{name.slice(0, 1)}
		</span>
	);
}

function Presence() {
	return (
		<div className="presence" aria-label="Kent, Michiel, and Louise are here">
			<div className="avatar-stack" aria-hidden="true">
				<Avatar name="Kent" tone="blue" />
				<Avatar name="Michiel" tone="violet" />
				<Avatar name="Louise" tone="coral" />
			</div>
			<span>3 here</span>
		</div>
	);
}

function ToolRow({
	icon,
	label,
	detail,
	active = false,
}: {
	icon: React.ReactNode;
	label: string;
	detail: string;
	active?: boolean;
}) {
	return (
		<div className={`tool-row${active ? " tool-row-active" : ""}`}>
			<span className="tool-icon">{icon}</span>
			<div>
				<strong>{label}</strong>
				<span>{detail}</span>
			</div>
			{active ? <span className="working-dot" /> : <IconCheck size={20} />}
		</div>
	);
}

function ProductPreview() {
	return (
		<div className="preview-wrap" aria-label="Sample multiplayer OpenSession workspace">
			<div className="preview-window">
				<div className="window-bar">
					<div className="window-controls" aria-hidden="true">
						<span />
						<span />
						<span />
					</div>
					<div className="window-title">
						<Mark small />
						<span>OpenSession</span>
					</div>
					<span className="sample-label">Sample workspace</span>
				</div>

				<div className="workspace-shell">
					<aside className="workspace-sidebar">
						<button className="new-session" type="button">
							<span>+</span> New session
						</button>
						<p className="sidebar-label">Workspaces</p>
						<div className="workspace-row workspace-row-active">
							<span className="repo-tile"><IconRepo size={20} /></span>
							<div>
								<strong>Multiplayer invites</strong>
								<span>tella-fusion</span>
							</div>
							<span className="live-dot" />
						</div>
						<div className="workspace-row">
							<span className="repo-tile repo-tile-green"><IconRepo size={20} /></span>
							<div>
								<strong>Billing webhooks</strong>
								<span>api</span>
							</div>
							<span className="row-count">2</span>
						</div>
						<div className="workspace-row">
							<span className="repo-tile repo-tile-gold"><IconRepo size={20} /></span>
							<div>
								<strong>Mobile composer</strong>
								<span>opensession</span>
							</div>
						</div>
						<div className="sidebar-bottom">
							<Avatar name="Kent" tone="blue" />
							<div><strong>Kent</strong><span>Online</span></div>
						</div>
					</aside>

					<main className="workspace-main">
						<header className="session-header">
							<div>
								<strong>Multiplayer workspace invitations</strong>
								<span><IconBranches size={20} /> feature/invite-presence</span>
							</div>
							<Presence />
						</header>
						<div className="session-tabs" role="tablist" aria-label="Workspace views">
							<span className="session-tab session-tab-active">Chat</span>
							<span className="session-tab">Review <b>1</b></span>
							<span className="session-tab">Preview</span>
						</div>

						<section className="conversation">
							<div className="message message-user">
								<div className="message-author">
									<Avatar name="Kent" tone="blue" />
									<strong>Kent</strong>
									<span>10:42</span>
								</div>
								<p>Add multiplayer presence to project workspaces. Have another agent cover the tests, then open a PR.</p>
							</div>

							<div className="message message-agent">
								<div className="message-author">
									<span className="agent-avatar"><IconSparkle size={20} /></span>
									<strong>Michael</strong>
									<span>Agent</span>
								</div>
								<p>I found the existing presence channel and workspace header. I’m wiring those together while a focused worker adds the coverage.</p>
								<div className="tool-stack">
									<ToolRow icon={<IconTerminal size={20} />} label="Read workspace presence" detail="4 files" />
									<ToolRow icon={<IconStack size={20} />} label="Delegated tests" detail="Worker agent · 3m" active />
									<ToolRow icon={<IconPullRequest size={20} />} label="Opened pull request" detail="#1842 · Ready for review" />
								</div>
							</div>

							<div className="collaborator-note">
								<Avatar name="Michiel" tone="violet" />
								<p><strong>Michiel joined</strong> and opened the Review tab</p>
								<span>now</span>
							</div>
						</section>

						<div className="composer-preview">
							<span>Ask Michael to change anything...</span>
							<kbd>⌘ Enter</kbd>
						</div>
					</main>

					<aside className="activity-rail">
						<div className="rail-heading"><span>Working together</span><Presence /></div>
						<div className="people-list">
							<div><Avatar name="Michiel" tone="violet" /><p><strong>Michiel</strong><span>Reviewing changes</span></p><i className="presence-dot" /></div>
							<div><Avatar name="Louise" tone="coral" /><p><strong>Louise</strong><span>Watching session</span></p><i className="presence-dot" /></div>
						</div>

						<p className="rail-label">Agent team</p>
						<div className="agent-card">
							<span className="agent-avatar"><IconSparkle size={20} /></span>
							<p><strong>Michael</strong><span>Implementing presence</span></p>
							<span className="working-dot" />
						</div>
						<div className="agent-card">
							<span className="agent-avatar agent-avatar-muted"><IconStack size={20} /></span>
							<p><strong>Test worker</strong><span>12 tests passed</span></p>
							<IconCheck size={20} />
						</div>

						<p className="rail-label">Pull request</p>
						<div className="pr-card">
							<div><IconPullRequest size={20} /><strong>#1842</strong><span className="ready-pill">Ready</span></div>
							<p>Show presence in workspace headers</p>
							<div className="checks"><IconCheck size={20} /> All checks passed</div>
						</div>
					</aside>
				</div>
			</div>
		</div>
	);
}

const features = [
	{
		number: "01",
		title: "Multiplayer by default",
		body: "Work in the same sessions, see who is present, and review agent output together instead of passing transcripts around.",
	},
	{
		number: "02",
		title: "An agent team, not one chat",
		body: "Delegate focused tasks to parallel agents, keep their progress visible, and bring the results back into one workspace.",
	},
	{
		number: "03",
		title: "Your infrastructure",
		body: "Run in git worktrees or isolated sandboxes on machines you control, with your models, tools, and integrations.",
	},
];

function CopyCommand() {
	const [copied, setCopied] = useState(false);
	async function copy() {
		await navigator.clipboard.writeText(installCommand);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1800);
	}

	return (
		<div className="command-line">
		<code><span>$</span> {installCommand}</code>
			<button type="button" onClick={copy} aria-label="Copy install command">
				{copied ? <IconCheck size={20} /> : <IconCopy size={20} />}
				<span aria-live="polite">{copied ? "Copied" : "Copy"}</span>
			</button>
		</div>
	);
}

function LandingPage() {
	return (
		<>
			<section className="hero">
				<div className="gradient-fallback" aria-hidden="true" />
				<Suspense fallback={null}>
					<TellaBackground />
				</Suspense>
				<div className="hero-wash" aria-hidden="true" />

				<header className="site-header page-width">
					<a className="brand" href="#top" aria-label="OpenSession home">
						<Mark />
						<span>OpenSession</span>
					</a>
					<nav aria-label="Main navigation">
						<a href="#why">Why OpenSession</a>
						<a href="https://github.com/tellahq/opensession">GitHub</a>
						<a className="nav-cta" href="#install">Get started</a>
					</nav>
				</header>

				<div className="hero-content page-width" id="top">
					<div className="hero-copy">
						<p className="eyebrow"><span /> Open source. Multiplayer by default.</p>
						<h1>Your team and its agents, in one workspace.</h1>
						<p className="hero-description">
							OpenSession is the multiplayer command center for coding agents. Start, steer, review, and ship work together, on your own infrastructure.
						</p>
						<div className="hero-actions">
							<a className="button button-primary" href="#install">Get started</a>
							<a className="button button-secondary" href="https://github.com/tellahq/opensession">
								View on GitHub <span aria-hidden="true">↗</span>
							</a>
						</div>
						<div className="proof-line" aria-label="OpenSession highlights">
							<span>Apache-2.0</span>
							<i />
							<span>Bring your own models</span>
							<i />
							<span>Web, desktop, and mobile</span>
						</div>
					</div>
					<ProductPreview />
				</div>
			</section>

			<main>
				<section className="why-section page-width" id="why">
					<div className="section-intro">
						<p className="section-kicker">Built for the whole team</p>
						<h2>Agent work is already collaborative. Your tools should be too.</h2>
					</div>
					<div className="feature-grid">
						{features.map((feature) => (
							<article key={feature.number}>
								<span>{feature.number}</span>
								<h3>{feature.title}</h3>
								<p>{feature.body}</p>
							</article>
						))}
					</div>
				</section>

				<section className="install-section page-width" id="install">
					<div className="install-card">
						<div className="install-copy">
							<p className="section-kicker section-kicker-dark">Start on your own machine</p>
							<h2>One command to your first session.</h2>
							<p>The installer adds Bun and OpenCode when needed, then walks you through the models and integrations you want to connect.</p>
						</div>
						<CopyCommand />
						<div className="install-meta">
							<span><IconTerminal size={20} /> Linux and macOS</span>
							<span><IconCheck size={20} /> Setup in under a minute</span>
						</div>
						<div className="trust-note">
							<IconRepo size={20} />
							<p><strong>Private by design.</strong> OpenSession trusts everyone who can reach it. Keep your instance on Tailscale, behind a VPN, or behind an SSH tunnel.</p>
						</div>
					</div>
				</section>
			</main>

			<footer className="site-footer page-width">
				<a className="brand brand-footer" href="#top"><Mark small /><span>OpenSession</span></a>
				<p>Open-source infrastructure for teams and their agents.</p>
				<nav aria-label="Footer navigation">
					<a href="https://github.com/tellahq/opensession">GitHub</a>
					<a href="https://github.com/tellahq/opensession/tree/main/docs/setup">Docs</a>
					<a href="https://github.com/tellahq/opensession/blob/main/SECURITY.md">Security</a>
				</nav>
			</footer>
		</>
	);
}

createRoot(document.getElementById("root")!).render(<LandingPage />);
