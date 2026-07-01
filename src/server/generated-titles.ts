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
import { query } from "@anthropic-ai/claude-agent-sdk";

const HOME = process.env.HOME || "/home/ubuntu";
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
	return raw
		.trim()
		.split("\n")[0] // first line only
		.replace(/^["'`]+|["'`]+$/g, "") // surrounding quotes
		.replace(/[.\s]+$/g, "") // trailing period/space
		.replace(/\s+/g, " ")
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
): Promise<string | null> {
	if (getGeneratedTitle(id)) return null; // already have one
	const source = prompt.trim().slice(0, 2000);
	if (!source) return null;

	let out = "";
	try {
		const q = query({
			prompt: `Summarize this coding task as a short title of 3 to 6 words, phrased as an imperative like a git branch or PR title (e.g. "Add onboarding flow", "Fix layout thumbnails", "Raise timeline playhead"). Sentence case, no trailing punctuation, no quotes, no code. Output ONLY the title, nothing else.\n\nTask:\n"""\n${source}\n"""`,
			options: {
				model: "haiku",
				maxTurns: 1,
				cwd: "/home/ubuntu/projects/tella-fusion",
				allowedTools: [],
				pathToClaudeCodeExecutable: "/home/ubuntu/.local/bin/claude",
				executable: "bun",
			},
		});
		for await (const msg of q) {
			if (msg.type === "result" && (msg as any).subtype === "success") {
				out = (msg as any).result || "";
			}
		}
	} catch (e) {
		console.error("[title] Error generating session title:", e);
		return null;
	}

	const title = sanitizeTitle(out);
	if (!title) return null;
	setGeneratedTitle(id, title);
	return title;
}
