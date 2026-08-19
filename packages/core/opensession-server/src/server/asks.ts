/**
 * Interactive AskUserQuestion: questions broadcast to session watchers, answered
 * from the UI. If nobody answers in the UI within ASK_UI_TIMEOUT_MS, the question
 * is escalated to the session's original prompter over Slack (the opensession-humans
 * transport) and we keep blocking on their reply; the UI question stays live the
 * whole time, so whoever answers first (web or Slack) wins.
 */

import { existsSync, readFileSync } from "fs";
import { personaName, productName } from "./config";
import {
	awaitBlockingAnswer,
	cancelAsk,
	getAsk,
	registerAsk,
} from "./human-asks";
import {
	AWS_HUMAN_AUTH_DENIAL,
	isAwsHumanAuthRequest,
} from "./aws-creds";
import { resolveTeammate } from "./shared/user-mappings";
import { transitionRunState } from "./run-state";
import { findSession } from "./session-cache";
import { sessionsDir } from "./paths";
import { tryGetSessionControl } from "./session-control";
import { writeJsonAtomic } from "./shared/atomic-write";
import { broadcastToSession } from "./ws-hub";

const g = globalThis as any;

const ASK_UI_TIMEOUT_MS = 4 * 60 * 1000;

// Moved to the protocol package (as AskQuestion); the old name stays for
// existing import sites.
export type { AskQuestion as AskQuestionInput } from "@tellahq/opensession-protocol/session";
import type { AskQuestion as AskQuestionInput } from "@tellahq/opensession-protocol/session";

export interface PendingAsk {
	questionId: string;
	questions: unknown[];
	resolve: (answers: Record<string, string> | null) => void;
	/** Only run-blocking asks are durable. offerAskCard is restored by human-asks. */
	durable?: boolean;
	askedAt?: number;
	escalatedAskId?: string;
	escalatedPersonName?: string;
	escalationWaitStarted?: boolean;
	answerReceived?: boolean;
	earlyAnswer?: Record<string, string> | null;
	restored?: boolean;
	/** Test/isolated-instance seam; live asks use pendingAskStorePath(). */
	storePath?: string;
}
export const pendingAsks: Map<string, PendingAsk> = (g.__pendingAsks ??=
	new Map());

type PersistedPendingAsk = {
	sessionId: string;
	questionId: string;
	questions: AskQuestionInput[];
	askedAt: number;
	escalatedAskId?: string;
	escalatedPersonName?: string;
	answerReceived?: boolean;
	earlyAnswer?: Record<string, string> | null;
};

type PendingAskTimer = {
	handle: ReturnType<typeof setTimeout>;
	dueAt: number;
};

export const pendingAskTimers: Map<string, PendingAskTimer> =
	(g.__pendingAskTimers ??= new Map());

export function pendingAskStorePath(): string {
	return `${sessionsDir()}/pending-asks.json`;
}

export function persistPendingAsks(storePath = pendingAskStorePath()): void {
	try {
		const asks: PersistedPendingAsk[] = [];
		for (const [sessionId, ask] of pendingAsks) {
			if (!ask.durable || !ask.askedAt) continue;
			asks.push({
				sessionId,
				questionId: ask.questionId,
				questions: ask.questions as AskQuestionInput[],
				askedAt: ask.askedAt,
				...(ask.escalatedAskId ? { escalatedAskId: ask.escalatedAskId } : {}),
				...(ask.escalatedPersonName
					? { escalatedPersonName: ask.escalatedPersonName }
					: {}),
				...(ask.answerReceived
					? { answerReceived: true, earlyAnswer: ask.earlyAnswer ?? null }
					: {}),
			});
		}
		writeJsonAtomic(storePath, { asks }, false, 0o600);
	} catch (e) {
		console.error("[ask] Failed to persist pending asks:", e);
	}
}

function clearAskTimer(sessionId: string): void {
	const timer = pendingAskTimers.get(sessionId);
	if (timer) clearTimeout(timer.handle);
	pendingAskTimers.delete(sessionId);
}

function retirePendingAsk(sessionId: string, questionId: string): void {
	clearAskTimer(sessionId);
	const ask = pendingAsks.get(sessionId);
	if (ask?.questionId === questionId) {
		pendingAsks.delete(sessionId);
		persistPendingAsks(ask.storePath);
	}
}

function sameQuestions(a: unknown[], b: AskQuestionInput[]): boolean {
	try {
		return JSON.stringify(a) === JSON.stringify(b);
	} catch {
		return false;
	}
}

function fallbackAnswerText(
	questions: AskQuestionInput[],
	answers: Record<string, string>,
): string {
	const lines = questions.map((question) => {
		const answer = answers[question.question] ?? "";
		return `**${question.question}**\n\n${answer}`;
	});
	return `💬 Answered after the server restarted:\n\n${lines.join("\n\n")}`;
}

/** A restored card initially has no in-process tool promise to resolve. If the
 * adopted engine re-emits its ask, makeAskHandler replaces this resolver with
 * the live one. An answer that wins that race still follows the ordinary
 * steer/queue path instead of disappearing. */
function resolveRestoredAsk(
	sessionId: string,
	questionId: string,
	questions: AskQuestionInput[],
	answers: Record<string, string> | null,
): void {
	const ask = pendingAsks.get(sessionId);
	if (ask?.questionId !== questionId || ask.answerReceived) return;
	clearAskTimer(sessionId);
	ask.answerReceived = true;
	ask.earlyAnswer = answers;
	if (ask.escalatedAskId) cancelAsk(ask.escalatedAskId);
	persistPendingAsks(ask.storePath);
	broadcastToSession(sessionId, {
		type: "ask_resolved",
		sessionId,
		questionId,
	});
	// Keep the answer with the card until the recovered engine re-emits the
	// matching AskUserQuestion. makeAskHandler then resolves the original tool
	// promise instead of turning the answer into an unrelated user prompt.
}

export function settleRestoredAskAfterRecovery(sessionId: string): boolean {
	const ask = pendingAsks.get(sessionId);
	if (!ask?.restored) return false;
	const answers = ask.answerReceived ? ask.earlyAnswer ?? null : null;
	retirePendingAsk(sessionId, ask.questionId);
	if (ask.escalatedAskId) cancelAsk(ask.escalatedAskId);
	broadcastToSession(sessionId, {
		type: "ask_resolved",
		sessionId,
		questionId: ask.questionId,
	});
	if (!answers) return false;
	const control = tryGetSessionControl();
	if (!control) {
		console.error(`[ask] No session control to deliver restored answer for ${sessionId}`);
		return false;
	}
	const session = findSession(sessionId);
	void control
		.deliverToSession(
			sessionId,
			fallbackAnswerText(ask.questions as AskQuestionInput[], answers),
			session?.startedBy || undefined,
			{ busy: "queue" },
		)
		.catch((e) =>
			console.error(`[ask] Failed to deliver restored answer for ${sessionId}:`, e),
		);
	return true;
}

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

function waitForEscalatedAnswer(
	sessionId: string,
	questionId: string,
	questions: AskQuestionInput[],
	askId: string,
	personName: string,
): void {
	const stored = getAsk(askId);
	if (!stored || stored.state === "answered" || stored.state === "cancelled") {
		const answer = stored?.state === "answered" ? stored.answer || null : null;
		queueMicrotask(() => {
			const current = pendingAsks.get(sessionId);
			if (current?.questionId !== questionId) return;
			current.resolve(
				answer == null ? null : slackAnswerToAnswers(questions, answer),
			);
		});
		return;
	}
	void awaitBlockingAnswer(askId).then((slackAnswer) => {
		const current = pendingAsks.get(sessionId);
		if (current?.questionId !== questionId) return;
		if (slackAnswer == null) {
			current.resolve(null);
			return;
		}
		broadcastToSession(sessionId, {
			type: "notice",
			message: `💬 **${personName}** answered (via Slack): ${slackAnswer}`,
		});
		current.resolve(slackAnswerToAnswers(questions, slackAnswer));
	});
}

function armAskEscalation(
	sessionId: string,
	ask: PendingAsk,
	questions: AskQuestionInput[],
	finish: (answers: Record<string, string> | null) => void,
	now = Date.now(),
): void {
	clearAskTimer(sessionId);
	if (!ask.askedAt) return;
	if (ask.escalatedAskId) {
		if (!ask.escalationWaitStarted) {
			ask.escalationWaitStarted = true;
			waitForEscalatedAnswer(
				sessionId,
				ask.questionId,
				questions,
				ask.escalatedAskId,
				ask.escalatedPersonName || "Your teammate",
			);
		}
		return;
	}
	const dueAt = ask.askedAt + ASK_UI_TIMEOUT_MS;
	const handle = setTimeout(() => {
		pendingAskTimers.delete(sessionId);
		if (pendingAsks.get(sessionId)?.questionId !== ask.questionId) return;
		void escalateAskToSlack(sessionId, questions).then((escalated) => {
			const current = pendingAsks.get(sessionId);
			if (!current || current.questionId !== ask.questionId) {
				if (escalated) cancelAsk(escalated.askId);
				return;
			}
			if (!escalated) {
				finish(null);
				return;
			}
			current.escalatedAskId = escalated.askId;
			current.escalatedPersonName = escalated.personName;
			current.escalationWaitStarted = true;
			persistPendingAsks(current.storePath);
			waitForEscalatedAnswer(
				sessionId,
				ask.questionId,
				questions,
				escalated.askId,
				escalated.personName,
			);
		});
	}, Math.max(0, dueAt - now));
	pendingAskTimers.set(sessionId, { handle, dueAt });
}

/** Restore run-blocking cards after a real process restart. The durable entry
 * stays display state only until the adopted engine re-emits the ask and
 * makeAskHandler adopts its original question id and askedAt. */
export function restorePendingAsks(options: {
	storePath?: string;
	now?: number;
	sessionExists?: (sessionId: string) => boolean;
} = {}): number {
	const storePath = options.storePath ?? pendingAskStorePath();
	if (!existsSync(storePath)) return 0;
	let stored: { asks?: PersistedPendingAsk[] };
	try {
		stored = JSON.parse(readFileSync(storePath, "utf8"));
	} catch (e) {
		console.error("[ask] Failed to restore pending asks:", e);
		return 0;
	}
	const sessionExists = options.sessionExists ?? ((sessionId) => !!findSession(sessionId));
	let restored = 0;
	for (const saved of stored.asks || []) {
		if (
			!saved?.sessionId ||
			!saved.questionId ||
			!Array.isArray(saved.questions) ||
			!Number.isFinite(saved.askedAt) ||
			!sessionExists(saved.sessionId) ||
			pendingAsks.has(saved.sessionId)
		) {
			continue;
		}
		const ask: PendingAsk = {
			questionId: saved.questionId,
			questions: saved.questions,
			durable: true,
			askedAt: saved.askedAt,
			...(saved.escalatedAskId
				? { escalatedAskId: saved.escalatedAskId }
				: {}),
			...(saved.escalatedPersonName
				? { escalatedPersonName: saved.escalatedPersonName }
				: {}),
			...(saved.answerReceived
				? {
						answerReceived: true,
						earlyAnswer: saved.earlyAnswer ?? null,
					}
				: {}),
			restored: true,
			storePath,
			resolve: (answers) =>
				resolveRestoredAsk(
					saved.sessionId,
					saved.questionId,
					saved.questions,
					answers,
				),
		};
		pendingAsks.set(saved.sessionId, ask);
		if (!ask.answerReceived) {
			armAskEscalation(
				saved.sessionId,
				ask,
				saved.questions,
				ask.resolve,
				options.now,
			);
			broadcastToSession(saved.sessionId, {
				type: "ask_question",
				sessionId: saved.sessionId,
				questionId: saved.questionId,
				questions: saved.questions,
			});
		}
		restored++;
	}
	// Drop invalid or deleted-session records immediately. A card removed before
	// the crash is absent because its answer path persists the delete first.
	persistPendingAsks(storePath);
	if (restored > 0) {
		console.log(`[ask] Restored ${restored} pending question(s) from before restart`);
	}
	return restored;
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

		const existing = pendingAsks.get(sessionId);
		const adopted =
			!!existing?.restored &&
			!!existing.durable &&
			sameQuestions(existing.questions, questions);
		if (existing?.restored && !adopted) {
			retirePendingAsk(sessionId, existing.questionId);
			broadcastToSession(sessionId, {
				type: "ask_resolved",
				sessionId,
				questionId: existing.questionId,
			});
		}
		const questionId = adopted ? existing!.questionId : crypto.randomUUID();
		const askedAt = adopted ? existing!.askedAt! : Date.now();
		let settled = false;
		let escalatedAskId = adopted ? existing!.escalatedAskId || null : null;

		const answers = await new Promise<Record<string, string> | null>(
			(resolve) => {
				const finish = (a: Record<string, string> | null) => {
					if (settled) return;
					settled = true;
					retirePendingAsk(sessionId, questionId);
					transitionRunState(sessionId, "ask_resolved", {
						answered: a !== null,
					});
					// If the web UI answered after we'd already pinged Slack, retract the
					// Slack ask so the teammate isn't left answering a moot question.
					if (escalatedAskId) cancelAsk(escalatedAskId);
					resolve(a);
				};

				const ask: PendingAsk = {
					questionId,
					questions,
					durable: true,
					askedAt,
					...(adopted && existing!.escalatedAskId
						? { escalatedAskId: existing!.escalatedAskId }
						: {}),
					...(adopted && existing!.escalatedPersonName
						? { escalatedPersonName: existing!.escalatedPersonName }
						: {}),
					...(adopted && existing!.escalationWaitStarted
						? { escalationWaitStarted: true }
						: {}),
					...(adopted && existing!.answerReceived
						? {
								answerReceived: true,
								earlyAnswer: existing!.earlyAnswer ?? null,
							}
						: {}),
					...(adopted && existing!.storePath
						? { storePath: existing!.storePath }
						: {}),
					resolve: (a) => finish(a),
				};
				pendingAsks.set(sessionId, ask);
				persistPendingAsks(ask.storePath);
				transitionRunState(sessionId, "ask_posed");
				if (ask.answerReceived) {
					queueMicrotask(() => ask.resolve(ask.earlyAnswer ?? null));
				} else {
					armAskEscalation(sessionId, ask, questions, (a) => {
						escalatedAskId = pendingAsks.get(sessionId)?.escalatedAskId || null;
						finish(a);
					});
					broadcastToSession(sessionId, {
						type: "ask_question",
						sessionId,
						questionId,
						questions,
					});
				}
				// Phone buzz: Web Push to the session owner's registered devices
				// (opt-in per device in Settings → Notifications). Best-effort —
				// never lets a push hiccup affect the ask flow. Deduped on the
				// question text: a restart resumes ask-blocked runs, which re-ask
				// the same question — that re-ask must not buzz again.
				if (!adopted && !ask.answerReceived) void (async () => {
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
								url: `/session/${encodeURIComponent(sessionId)}`,
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
