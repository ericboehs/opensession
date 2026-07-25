/**
 * Auto-generated short "summary" titles for sessions — the Conductor-style
 * 3-6 word name (e.g. "Add onboarding flow") instead of the raw first line of
 * the prompt. Lives in a backstage-owned registry keyed by unified session id,
 * applied UNDER the manual rename registry (title-overrides) but OVER the
 * derived first-line title in getAllSessions.
 *
 * Generation is a one-shot Haiku call (see generateSessionTitle), fired in the
 * background at session creation so it never blocks the create path.
 */
import { readFileSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { BACKSTAGE_CHATS_DIR } from "./paths";
import { opencodeOneShot } from "./opencode-oneshot";

const REGISTRY_PATH = `${BACKSTAGE_CHATS_DIR}/generated-titles.json`;

let cache: Record<string, string> | null = null;

function load(): Record<string, string> {
	if (cache) return cache;
	try {
		cache = existsSync(REGISTRY_PATH)
			? JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"))
			: {};
	} catch {
		cache = {};
	}
	return cache!;
}

function save(registry: Record<string, string>): void {
	cache = registry;
	writeJsonAtomic(REGISTRY_PATH, registry);
}

export function getGeneratedTitle(id: string): string | undefined {
	return load()[id];
}

function setGeneratedTitle(id: string, title: string): void {
	const registry = { ...load() };
	registry[id] = title;
	save(registry);
}

/** Trim a raw model output into a clean short title, or "" if unusable. */
function sanitizeTitle(raw: string): string {
	const line = raw
		.trim()
		.split("\n")[0] // first line only
		.replace(/^["'`]+|["'`]+$/g, "") // surrounding quotes
		.replace(/\s+/g, " ")
		.trim();
	// The model occasionally answers instead of naming ("This isn't a coding
	// task — it's a question to investigate. The ..."), which the 60-char slice
	// would bake in as a title. Reject prose — long-winded output, an internal
	// sentence break, or a first-person/deictic opener no imperative title has —
	// and keep the derived first-line title instead.
	if (
		line.split(" ").length > 9 ||
		/\.\s/.test(line) ||
		/^(i|i'm|this|that|there|sorry|it)\b/i.test(line)
	)
		return "";
	return line
		.replace(/[.\s]+$/g, "") // trailing period/space
		.slice(0, 60)
		.trim();
}

/**
 * Generate and store a short summary title for a session from its opening
 * prompt, unless one already exists. Fire-and-forget: returns the title on
 * success, or null (leaves the derived first-line title in place). Callers
 * should invalidate their sessions cache when a non-null title comes back.
 */
export async function ensureGeneratedTitle(
	id: string,
	prompt: string,
	user?: string,
	model?: string,
): Promise<string | null> {
	if (getGeneratedTitle(id)) return null; // already have one
	// Desk sessions keep their fixed title (direct file read — importing the
	// sessions cache here would be an import cycle).
	try {
		const f = `${BACKSTAGE_CHATS_DIR}/${id}.json`;
		if (existsSync(f) && JSON.parse(readFileSync(f, "utf-8")).desk) return null;
	} catch {}
	const source = prompt.trim().slice(0, 2000);
	if (!source) return null;

	const out = await opencodeOneShot(
		`Summarize this task as a short title of 3 to 6 words, phrased as an imperative like a git branch or PR title (e.g. "Add onboarding flow", "Fix layout thumbnails", "Raise timeline playhead"). Sentence case, no trailing punctuation, no quotes, no code. Always name the task, even when it is a question, an investigation or a discussion rather than a code change — never comment on the task itself. Output ONLY the title, nothing else.\n\nTask:\n"""\n${source}\n"""`,
		{ user, label: "generated-titles" },
	);
	if (!out) return null;

	const title = sanitizeTitle(out);
	if (!title) return null;
	setGeneratedTitle(id, title);
	return title;
}
