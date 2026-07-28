/**
 * Interactive AskUserQuestion: questions broadcast to session watchers, answered
 * from the UI. If nobody answers in the UI within ASK_UI_TIMEOUT_MS, the question
 * is escalated to the session's original prompter over Slack (the opensession-humans
 * transport) and we keep blocking on their reply; the UI question stays live the
 * whole time, so whoever answers first (web or Slack) wins.
 */

import { personaName } from "./config";
import { productName } from "./config";
import {
	awaitBlockingAnswer,
	cancelAsk,
	registerAsk,
} from "./human-asks";
import {
	AWS_HUMAN_AUTH_DENIAL,
	isAwsHumanAuthRequest,
} from "./aws-creds";
import { resolveTeammate } from "./shared/user-mappings";
import { transitionRunState } from "./run-state";
import { findSession } from "./session-cache";
import { broadcastToSession } from "./ws-hub";

const g = globalThis as any;

const ASK_UI_TIMEOUT_MS = 4 * 60 * 1000;

export interface AskQuestionInput {
	question: string;
	header?: string;
	options?: Array<{ label: string; description?: string }>;
	multiSelect?: boolean;
}

export interface PendingAsk {
	questionId: string;
	questions: unknown[];
	resolve: (answers: Record<string, string> | null) => void;
}
export const pendingAsks: Map<string, PendingAsk> = (g.__pendingAsks ??=
	new Map());

// Flatten an AskUserQuestion payload into a single Slack-friendly prompt. Option
// buttons are only offered when there's exactly one question (the human-asks card
// carries one option set); multi-question asks fall back to a free-text reply.
function askToSlackPrompt(questions: AskQuestionInput[]): {
	question: string;
	options?: string[];
} {
	if (questions.length === 1) {
		const q = questions[0];
		const text = q.header ? `*${q.header}* — ${q.question}` : q.question;
		return { question: text, options: q.options?.map((o) => o.label) };
	}
	const text = questions
		.map(
			(q, i) => `${i + 1}. ${q.header ? `*${q.header}* — ` : ""}${q.question}`,
		)
		.join("\n");
	return { question: text };
}

// A Slack reply is a single string; apply it as the answer to every question so
// the AskUserQuestion result has a value for each key it expects.
function slackAnswerToAnswers(
	questions: AskQuestionInput[],
	answer: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const q of questions) out[q.question] = answer;
	return out;
}

/**
 * Offer a question card on the session WITHOUT the makeAskHandler timeout /
 * Slack-escalation machinery: the card stays up until answered or `close()`d
 * by the caller. Built for humans-tools' blocking Slack asks — the DM is the
 * primary channel and already pings the asked teammate; this card gives the
 * session's own watcher a way to answer (or acknowledge an out-of-band action
 * like an SSO login) without interrupting the run. Answering calls `onAnswer`
 * once; closing retracts the card and never calls it.
 */
export function offerAskCard(
	sessionId: string,
	questions: AskQuestionInput[],
	onAnswer: (answers: Record<string, string> | null) => void,
): { close: () => void } {
	const questionId = crypto.randomUUID();
	let settled = false;
	const retract = () => {
		if (pendingAsks.get(sessionId)?.questionId === questionId) {
			pendingAsks.delete(sessionId);
		}
		broadcastToSession(sessionId, {
			type: "ask_resolved",
			sessionId,
			questionId,
		});
	};
	pendingAsks.set(sessionId, {
		questionId,
		questions,
		resolve: (a) => {
			if (settled) return;
			settled = true;
			retract();
			onAnswer(a);
		},
	});
	broadcastToSession(sessionId, {
		type: "ask_question",
		sessionId,
		questionId,
		questions,
	});
	return {
		close: () => {
			if (settled) return;
			settled = true;
			retract();
		},
	};
}

export function makeAskHandler(sessionId: string) {
	return async (
		input: Record<string, unknown>,
	): Promise<
		| { behavior: "allow"; updatedInput: Record<string, unknown> }
		| { behavior: "deny"; message: string }
	> => {
		const questions = input.questions as AskQuestionInput[] | undefined;
		if (!questions || questions.length === 0) {
			return { behavior: "allow", updatedInput: input };
		}
		if (
			questions.some((q) =>
				isAwsHumanAuthRequest(q.header, q.question),
			)
		) {
			return {
				behavior: "deny",
				message: AWS_HUMAN_AUTH_DENIAL,
			};
		}

		const questionId = crypto.randomUUID();
		let settled = false;
		let escalatedAskId: string | null = null;

		const answers = await new Promise<Record<string, string> | null>(
			(resolve) => {
				const finish = (a: Record<string, string> | null) => {
					if (settled) return;
					settled = true;
					clearTimeout(timeoutId);
					pendingAsks.delete(sessionId);
					transitionRunState(sessionId, "ask_resolved", {
						answered: a !== null,
					});
					// If the web UI answered after we'd already pinged Slack, retract the
					// Slack ask so the teammate isn't left answering a moot question.
					if (escalatedAskId) cancelAsk(escalatedAskId);
					resolve(a);
				};

				// No UI answer in time → ask the original prompter over Slack and keep
				// blocking on their reply (the UI question stays live in parallel).
				const timeoutId = setTimeout(() => {
					void escalateAskToSlack(sessionId, questions).then((esc) => {
						if (settled) {
							// UI answered in the race window — undo the just-created ask.
							if (esc) cancelAsk(esc.askId);
							return;
						}
						if (!esc) {
							// No teammate to ask (e.g. automation-owned) — fall back to deny.
							finish(null);
							return;
						}
						escalatedAskId = esc.askId;
						void awaitBlockingAnswer(esc.askId).then((slackAnswer) => {
							if (slackAnswer == null) {
								finish(null);
								return;
							}
							// The answer folds into the AskUserQuestion tool result (the agent
							// continues), but that's invisible in the UI — surface it as an
							// attributed bubble so the human sees their Slack reply land, the
							// same way the async human-asks path does.
							broadcastToSession(sessionId, {
								type: "notice",
								message: `💬 **${esc.personName}** answered (via Slack): ${slackAnswer}`,
							});
							finish(slackAnswerToAnswers(questions, slackAnswer));
						});
					});
				}, ASK_UI_TIMEOUT_MS);

				pendingAsks.set(sessionId, {
					questionId,
					questions,
					resolve: (a) => finish(a),
				});
				transitionRunState(sessionId, "ask_posed");
				broadcastToSession(sessionId, {
					type: "ask_question",
					sessionId,
					questionId,
					questions,
				});
				// Phone buzz: Web Push to the session owner's registered devices
				// (opt-in per device in Settings → Notifications). Best-effort —
				// never lets a push hiccup affect the ask flow. Deduped on the
				// question text: a restart resumes ask-blocked runs, which re-ask
				// the same question — that re-ask must not buzz again.
				void (async () => {
					try {
						const s = findSession(sessionId);
						if (!s?.startedBy) return;
						const { sendPushToUser } = await import("./push");
						const { createHash } = await import("node:crypto");
						const qHash = createHash("sha256")
							.update(questions.map((q) => q.question).join("\n"))
							.digest("hex")
							.slice(0, 16);
						await sendPushToUser(
							s.startedBy,
							{
								title: `${personaName()} needs input`,
								body: `${s.title || sessionId} — ${questions[0]?.question || "a question is waiting"}`.slice(0, 180),
								url: `/backstage/session/${encodeURIComponent(sessionId)}`,
								tag: `ask-${sessionId}`,
							},
							{ dedupeKey: `ask:${sessionId}:${qHash}` },
						);
					} catch {}
				})();
			},
		);

		broadcastToSession(sessionId, {
			type: "ask_resolved",
			sessionId,
			questionId,
		});

		if (!answers) {
			return {
				behavior: "deny",
				message:
					"Nobody answered in time (web or Slack). Proceed with your best judgment and clearly note the open question and the assumption you made.",
			};
		}
		return { behavior: "allow", updatedInput: { ...input, answers } };
	};
}

// Escalate an unanswered AskUserQuestion to the session's original prompter over
// Slack. Returns the human-ask id (await its blocking answer) + who we asked, or
// null when we can't resolve a teammate. Best-effort: never throws into the handler.
async function escalateAskToSlack(
	sessionId: string,
	questions: AskQuestionInput[],
): Promise<{ askId: string; personName: string } | null> {
	try {
		const session = findSession(sessionId);
		const person = resolveTeammate(session?.startedBy ?? null);
		if (!person) return null;

		const { question, options } = askToSlackPrompt(questions);
		const ask = registerAsk({
			sessionId,
			createdBy: session?.startedBy || personaName(),
			person,
			question,
			context: `_Nobody picked this up in ${productName()} within 4 minutes, so I'm bringing it to you._`,
			options,
			mode: "block",
			deliver: "now",
		});
		broadcastToSession(sessionId, {
			type: "notice",
			message: `No answer in ${productName()} — asked ${person.name} over Slack.`,
		});
		return { askId: ask.id, personName: person.name };
	} catch (e) {
		console.error("[ask] Slack escalation failed:", e);
		return null;
	}
}
