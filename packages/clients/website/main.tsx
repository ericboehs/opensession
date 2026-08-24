import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import markAsset from "../mac/build/icon-512.png";
import {
	IconBranches,
	IconClock,
	IconGlobe,
	IconPeople,
	IconPhone,
	IconPullRequest,
	IconRepo,
	IconRobot,
	IconSparkle,
	IconStack,
	IconTerminal,
} from "../../core/opensession-server/src/frontend/components/icons";
import "./site.css";
import { AgentationFeedback } from "./AgentationFeedback";
import { MarbleField } from "./MarbleField";
import { ProductDemo } from "./ProductDemo";
import { TellaBackground } from "./TellaBackground";
import { assetUrl } from "./asset-url";

const markUrl = assetUrl(markAsset);

function Mark() {
	return (
		<span className="mark">
			<img src={markUrl} alt="" />
		</span>
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
					{/* The two asks sit on one line with a real gap between them. No
					    chevron on the second: an arrow on one of a pair makes it read as
					    a link that wandered into a button. */}
					<div className="rail-cta">
						<a
							className="button button-primary"
							href="https://github.com/tellahq/opensession"
						>
							View on GitHub
						</a>
						<a className="button button-secondary" href="setup">
							Set up your server
						</a>
					</div>
					<p className="rail-note">
						Open source and self-hosted.
						<br />
						Any model, on machines you own.
						<br />
						Available on macOS, iOS and web.
					</p>
				</div>
			</aside>

			<main className="feed">
				{/* The field is the loud surface now, so the stage uses the neutral
				    Silver Silk loop instead of another colourful background. */}
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
		<MarbleField />
		<LandingPage />
		<AgentationFeedback />
	</>,
);
