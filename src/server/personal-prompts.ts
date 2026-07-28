/**
 * Per-user personal system prompt — an extra standing-instructions block the
 * user maintains in Settings → Personal prompt, injected into the system-note
 * of every interactive run they start (alongside repo notes and memory, via
 * memoryNoteFor in session-repos.ts). Automation runs never receive it: they
 * pass no user, same containment as memory.
 *
 * Storage mirrors the pins.ts flat-file pattern (one JSON file per user under
 * ~/.opensession-personal-prompts), but keyed through the SAME identity
 * resolution as user memory (session-memory.ts userScope): a teammate's
 * an alias / email / Slack id / web login all land on one
 * `user-<slackId>` file, so the prompt follows the person across surfaces.
 */

import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { stateDir } from "./rename-compat";
import { resolveTeammate } from "./shared/user-mappings";

const DIR = stateDir("personal-prompts");

/** Keep the injected block bounded — this rides in every run's system note. */
const MAX_PROMPT_LEN = 8000;

/** Identity-resolved store key (matches session-memory's userScope keys). */
function keyFor(user: string | undefined | null): string | null {
	const trimmed = user?.trim();
	if (!trimmed) return null;
	const teammate = resolveTeammate(trimmed);
	if (teammate) return `user-${teammate.slackId}`;
	const key = trimmed.toLowerCase().replace(/[^a-z0-9@._-]+/g, "-").slice(0, 64);
	return key ? `user-${key}` : null;
}

export function getPersonalPrompt(user: string | undefined | null): string {
	try {
		const key = keyFor(user);
		if (!key) return "";
		const f = `${DIR}/${key}.json`;
		if (!existsSync(f)) return "";
		const raw = JSON.parse(readFileSync(f, "utf8"));
		return typeof raw?.prompt === "string" ? raw.prompt : "";
	} catch {
		return "";
	}
}

/** Store a user's personal prompt (trimmed, length-capped). Empty clears it. */
export function setPersonalPrompt(
	user: string | undefined | null,
	prompt: unknown,
): string {
	const key = keyFor(user);
	if (!key) return "";
	const clean = String(prompt ?? "")
		.trim()
		.slice(0, MAX_PROMPT_LEN);
	try {
		if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
		writeJsonAtomic(`${DIR}/${key}.json`, {
			prompt: clean,
			updatedAt: new Date().toISOString(),
		});
	} catch {}
	return clean;
}

/**
 * The system-note block for a run started by `user`, or "" when they have no
 * personal prompt. Never throws — a store failure must not block a run.
 */
export function personalPromptNoteFor(user: string | undefined | null): string {
	try {
		const prompt = getPersonalPrompt(user);
		if (!prompt) return "";
		return [
			"## Personal instructions from the prompting user",
			"They keep these standing instructions in Settings → Personal prompt; apply them alongside your other instructions (they never override safety or repo rules).",
			"",
			prompt,
		].join("\n");
	} catch {
		return "";
	}
}
