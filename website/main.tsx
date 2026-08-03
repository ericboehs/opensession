import { useState } from "react";
import { createRoot } from "react-dom/client";
import markUrl from "../os1-mac/build/icon-512.png";
import { IconCheck, IconCopy, IconRepo, IconTerminal } from "../src/frontend/components/icons";
import productUiUrl from "./product-ui.webp";
import "./site.css";
import { TellaBackground } from "./TellaBackground";

const installCommand =
	"curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash";

function Mark({ small = false }: { small?: boolean }) {
	return (
		<span className={small ? "mark mark-small" : "mark"}>
			<img src={markUrl} alt="" />
		</span>
	);
}

function ProductPreview() {
	return (
		<figure className="preview-wrap">
			<img
				className="product-preview"
				src={productUiUrl}
				alt="OpenSession workspace showing parallel agent work in a shared coding session"
			/>
			<figcaption>Actual OpenSession web interface</figcaption>
		</figure>
	);
}

const features = [
	{
		number: "01",
		title: "Run agents in parallel",
		body: "Fan work out across models and focused child sessions. Each task keeps its own context and progress, then reports back to the main thread.",
	},
	{
		number: "02",
		title: "Collaborate in every session",
		body: "Teammates can watch live, answer questions, steer runs, and review agent output together from the web, desktop, or phone.",
	},
	{
		number: "03",
		title: "Ship from your own stack",
		body: "Run in git worktrees or isolated sandboxes on machines you control, using your existing model accounts, tools, and integrations.",
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
				<TellaBackground />
				<div className="hero-wash" aria-hidden="true" />

				<header className="site-header page-width">
					<a className="brand" href="#top" aria-label="OpenSession home">
						<Mark />
						<span>OpenSession</span>
					</a>
					<nav aria-label="Main navigation">
						<a href="#why">How it works</a>
						<a href="https://github.com/tellahq/opensession">GitHub</a>
						<a className="nav-cta" href="#install">Get started</a>
					</nav>
				</header>

				<div className="hero-content page-width" id="top">
					<div className="hero-copy">
						<p className="eyebrow"><span /> Open source. Built for agent teams.</p>
						<h1>Run your coding agents. Together.</h1>
						<p className="hero-description">
							Use Claude, Codex, and other models side by side. Start parallel sessions, bring in teammates, and keep every prompt, diff, review, and PR moving from desktop or phone.
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
							<span>Use your existing subscriptions</span>
							<i />
							<span>Worktrees and sandboxes</span>
						</div>
					</div>
					<ProductPreview />
				</div>
			</section>

			<main>
				<section className="why-section page-width" id="why">
					<div className="section-intro">
						<p className="section-kicker">One place for the whole agent loop</p>
						<h2>Agents move faster when the whole team can see the work.</h2>
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
							<h2>Running in under a minute.</h2>
							<p>The installer adds Bun and OpenCode when needed, then connects the model subscriptions and integrations you already use.</p>
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
				<p>The open-source workspace for teams building with agents.</p>
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
