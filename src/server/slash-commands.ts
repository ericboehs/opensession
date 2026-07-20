/**
 * Backstage-native slash commands (/goal /loop /model /sub /compact /help) —
 * consumed by the WS prompt path, the opensession-sessions send_to_session tool,
 * and interactive resumes. Returns a notice string when the message was handled
 * as a command, or null to send it to the engine as a normal prompt.
 */

import { productName } from "./config";
import {
	listAccountsPublic,
	type ClaudeAccountPublic,
} from "./claude-accounts";
import {
	formatModelList,
	getDefaultModel,
	modelLabel,
	providerFor,
	resolveModel,
} from "./models";
import { engineFamily } from "./agent-runner";
import { syncAgentSessionEngine } from "./agent-session-sync";
import { touchBackstageSession } from "./session-cache";
import { broadcastToSession } from "./ws-hub";
import type { UnifiedSession } from "./types";

/**
 * Backstage-native slash commands. Returns a notice string when the message
 * was consumed as a command, or null to send it to Claude as a normal prompt.
 */
export function handleSlashCommand(
	session: UnifiedSession,
	text: string,
	user?: string,
): string | null {
	if (
		!text.startsWith("/goal") &&
		!text.startsWith("/loop") &&
		!text.startsWith("/model") &&
		text !== "/sub" &&
		!text.startsWith("/sub ") &&
		text !== "/compact" &&
		!text.startsWith("/compact ") &&
		text !== "/help"
	) {
		return null;
	}
	if (session.source !== "backstage") {
		// /model works on slack-source sessions too: persistence goes through
		// syncAgentSessionEngine — the one sanctioned writer into
		// ~/.slack-sessions (patches the file AND the loop's in-memory copy) —
		// so the UI picker/composer can switch a Slack thread's model without
		// racing the owning loop. Everything else stays agent-owned.
		if (!(session.source === "slack" && text.startsWith("/model"))) {
			return "Slash commands only work on backstage-created sessions (Slack/Linear session files are agent-owned).";
		}
	}

	if (text === "/help") {
		return [
			`${productName()} commands:`,
			"/goal <text> — pin a goal, appended to every prompt until cleared",
			"/goal clear — remove the goal",
			"/loop <interval> <prompt> — re-run a prompt on an interval (e.g. /loop 30m check CI and fix failures)",
			"/loop stop — stop the loop",
			"/model — show the session's model and what's available",
			"/model <name> — switch model (e.g. /model opus, /model gpt-5.5)",
			"/sub — show the session's pinned Claude subscription and what's available",
			"/sub <name> — pin a specific subscription for this session's runs",
			"/sub auto — back to automatic (personal-first, shared-pool fallback)",
			"/compact — summarize the conversation so far to shrink context and cost (Claude sessions only)",
		].join("\n");
	}

	if (text === "/model" || text === "/model show" || text === "/model list") {
		return [
			`Current model: ${session.model || getDefaultModel()}${session.model ? "" : " (default)"}`,
			"",
			"Available models (set with /model <name or alias>):",
			formatModelList(session.model),
		].join("\n");
	}
	if (text.startsWith("/model ")) {
		const input = text.slice("/model ".length).trim();
		const resolved = resolveModel(input);
		if (!resolved) {
			return [
				`Unknown model "${input}". Available:`,
				formatModelList(session.model),
			].join("\n");
		}
		const prevModel = session.model || getDefaultModel();
		if (session.source === "slack") {
			if (resolveModel(prevModel)?.id === resolved.id) {
				return `Already on ${resolved.id}.`;
			}
			// Slack session files don't carry modelHistory; the sync writer
			// patches the model field only (existing files, atomic).
			if (!syncAgentSessionEngine(session, { model: resolved.id })) {
				return "Couldn't update the Slack session file — send /model <name> in the Slack thread instead.";
			}
		} else {
			touchBackstageSession(session.id, {
				model: resolved.id,
				modelHistory: [
					...(session.modelHistory || []),
					{ model: resolved.id, from: prevModel, at: new Date().toISOString(), by: user },
				],
			});
		}
		// Everyone watching sees the switch (pill + inline divider) immediately
		broadcastToSession(session.id, {
			type: "model_changed",
			sessionId: session.id,
			model: resolved.id,
			from: prevModel,
			by: user,
		});
		// Compare underlying engine families, not resolveModel providers: a
		// stored opencode/<provider>/<model> id reports provider "opencode",
		// which would false-positive against a native id's "claude"/"codex".
		const switchedProvider =
			engineFamily(prevModel) !== engineFamily(resolved.id);
		return (
			`Model set to ${resolved.id} (${modelLabel(resolved.id)}). Applies from the next prompt.` +
			(switchedProvider
				? engineFamily(resolved.id) === "openai"
					? " Heads up: this hands the wheel to Codex on the next prompt. The Codex engine can't share Claude's internal thread, so it gets a transcript handoff of the conversation so far and continues from there (switching back to a Claude model resumes its own history)."
					: " Heads up: this hands the wheel back to Claude on the next prompt. Claude resumes its own earlier history (if any) and gets a transcript handoff of the turns Codex ran in between."
				: "")
		);
	}

	// Pin (or clear) the Claude subscription used for this session's runs. Like
	// /model, it persists on the session, broadcasts to every viewer, and applies
	// from the next prompt; unlike /model it's a preference the runner falls back
	// off when the pinned account is exhausted (never a hard requirement).
	if (text === "/sub" || text === "/sub show" || text === "/sub list") {
		const accounts = listAccountsPublic();
		const current = session.accountId
			? accounts.find((a) => a.id === session.accountId)
			: null;
		const line = (a: ClaudeAccountPublic) =>
			`${a.id === session.accountId ? "• " : "  "}${a.name}` +
			`${a.owner ? ` (personal — ${a.owner})` : " (pool)"}` +
			`${a.usable ? "" : " — exhausted"}`;
		return [
			`Subscription: ${current ? current.name : "auto (personal-first, pool fallback)"}`,
			"",
			"Available (set with /sub <name>, or /sub auto to unpin):",
			...accounts.map(line),
		].join("\n");
	}
	if (
		text === "/sub auto" ||
		text === "/sub clear" ||
		text === "/sub none" ||
		text === "/sub default"
	) {
		touchBackstageSession(session.id, { accountId: undefined });
		broadcastToSession(session.id, {
			type: "subscription_changed",
			sessionId: session.id,
			accountId: null,
			name: null,
			by: user,
		});
		return "Subscription set to auto (personal-first, shared-pool fallback). Applies from the next prompt.";
	}
	if (text.startsWith("/sub ")) {
		const input = text.slice("/sub ".length).trim();
		const accounts = listAccountsPublic();
		const match =
			accounts.find((a) => a.id === input) ||
			accounts.find((a) => a.name.toLowerCase() === input.toLowerCase());
		if (!match) {
			return [
				`Unknown subscription "${input}". Available:`,
				...accounts.map((a) => `  ${a.name}${a.owner ? ` (personal — ${a.owner})` : " (pool)"}`),
			].join("\n");
		}
		touchBackstageSession(session.id, { accountId: match.id });
		broadcastToSession(session.id, {
			type: "subscription_changed",
			sessionId: session.id,
			accountId: match.id,
			name: match.name,
			by: user,
		});
		const codexNote =
			providerFor(session.model) === "codex"
				? " Note: this session is on a Codex model, which uses its own accounts — the pin applies when you switch back to a Claude model."
				: "";
		const exhaustedNote = match.usable
			? ""
			: " Heads up: this subscription is currently exhausted, so runs fall back to the pool until it resets.";
		return `Subscription pinned to ${match.name}. Applies from the next prompt.${codexNote}${exhaustedNote}`;
	}

	// /compact is a built-in command of the Claude Agent SDK, not a backstage
	// config change: we return null so the "/compact" text flows through to the
	// runner, where the SDK summarizes the live context and continues from that
	// summary (emitting a compact_boundary). We intercept only to (a) block it on
	// Codex sessions, which have no such command and would otherwise get the
	// literal text as a prompt, and (b) give the room immediate feedback, since
	// the SDK's own output for the command is terse. Unlike the marathon-session
	// problem this exists to fight, it's a manual lever — auto-compact still only
	// fires near the context-window ceiling.
	if (text === "/compact" || text.startsWith("/compact ")) {
		if (providerFor(session.model) === "codex") {
			return "/compact only applies to Claude sessions — Codex manages its own context window. Switch to a Claude model with /model first, or start a fresh session to shed context.";
		}
		broadcastToSession(session.id, {
			type: "notice",
			sessionId: session.id,
			message:
				"Compacting context — the next reply continues from a summary of the conversation so far.",
		});
		return null; // fall through: the SDK runs its built-in /compact on this turn
	}

	if (text === "/goal" || text === "/goal show") {
		return session.goal
			? `Current goal: ${session.goal}`
			: "No goal set. Use /goal <text>.";
	}
	if (text === "/goal clear") {
		touchBackstageSession(session.id, { goal: undefined });
		return "Goal cleared.";
	}
	if (text.startsWith("/goal ")) {
		const goal = text.slice("/goal ".length).trim();
		if (!goal) return "Usage: /goal <text>";
		touchBackstageSession(session.id, { goal });
		return `Goal pinned: ${goal} — it will ride along with every prompt until /goal clear.`;
	}

	if (text === "/loop" || text === "/loop status") {
		return session.loop
			? `Loop active: every ${session.loop.intervalMinutes}m — "${session.loop.prompt}"`
			: "No loop set. Use /loop <interval> <prompt> (e.g. /loop 30m check CI).";
	}
	if (text === "/loop stop" || text === "/loop off" || text === "/loop clear") {
		touchBackstageSession(session.id, { loop: undefined });
		return "Loop stopped.";
	}
	if (text.startsWith("/loop ")) {
		const rest = text.slice("/loop ".length).trim();
		const match = rest.match(/^(\d+)\s*(m|min|h|hr)?\s+([\s\S]+)$/);
		if (!match)
			return "Usage: /loop <interval> <prompt> — e.g. /loop 30m check CI and fix failures";
		let minutes = parseInt(match[1]);
		if (match[2] === "h" || match[2] === "hr") minutes *= 60;
		minutes = Math.max(5, minutes);
		const prompt = match[3].trim();
		touchBackstageSession(session.id, {
			loop: {
				prompt,
				intervalMinutes: minutes,
				lastRunAt: new Date().toISOString(),
				setBy: user,
			},
		});
		return `Loop set: every ${minutes}m — "${prompt}". First run in ${minutes}m; /loop stop to end it.`;
	}

	return null;
}
