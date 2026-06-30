/**
 * Actions: a quick way to run a registered repo script behind a form.
 *
 * An Action = (1) an input form + (2) a way to execute a script. v1 registers
 * existing scripts that live in a repo (e.g. packages/scripts/make_michiel_editor.sh)
 * and maps the form fields to the script's arguments. A run is NOT a bespoke
 * output panel — it spins up a real backstage session on a fast/cheap model
 * (Haiku) that executes the command and reports the output, so it shows up in
 * the sessions list with a transcript and can be forked into a full session to
 * dig in. (Inline js/bash scripts authored in the UI come in a later version.)
 *
 * Records live in ~/.backstage-actions/<id>.json. The make_*_editor.sh family
 * is code-seeded (create-if-absent) so the actions exist without a data import
 * and UI edits are preserved.
 */
import { randomUUIDv7 } from "bun";
import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { runAgent } from "./agent-runner";
import { STRIPE_CONFIRM_TOOLS } from "./claude-runner";
import { providerFor, resolveModel, DEFAULT_FALLBACK_MODEL } from "./models";
import type { BackstageSessionFile } from "./types";

const HOME = process.env.HOME || "/home/ubuntu";
const ACTIONS_DIR = `${HOME}/.backstage-actions`;
const SESSIONS_DIR = `${HOME}/.backstage-sessions`;
const TELLA_FUSION = `${HOME}/projects/tella-fusion`;

/** Fast/cheap model for action runs (the LLM only orchestrates one Bash call). */
const ACTION_MODEL = "claude-haiku-4-5";

/** Repos an action's script can live in, mapped to their checkout path. */
const REPO_PATHS: Record<string, string> = {
  "tella-fusion": TELLA_FUSION,
};

export type ActionInputType = "text" | "number" | "select" | "boolean";

export interface ActionInput {
  /** Variable name — the positional order (or env var name) the value maps to. */
  name: string;
  /** Human label shown in the form. Falls back to `name`. */
  label?: string;
  type: ActionInputType;
  required?: boolean;
  default?: string;
  /** Options for `select` inputs. */
  options?: string[];
  /** Helper text under the field. */
  hint?: string;
}

export interface Action {
  id: string;
  name: string;
  description?: string;
  /** Repo the script lives in (key of REPO_PATHS). v1: always "tella-fusion". */
  repo: string;
  /** Script path relative to the repo root, e.g. "packages/scripts/make_michiel_editor.sh". */
  scriptPath: string;
  /** Form fields, in the order they map to positional args. */
  inputs: ActionInput[];
  /** How input values reach the script. positional = bash x a b; env = A=a B=b bash x. */
  argMode: "positional" | "env";
  /**
   * Require an explicit confirm before running. Default true for actions that
   * touch prod (the make_*_editor family writes straight to prod DynamoDB).
   */
  confirm?: boolean;
  /** Model override for runs; omitted = the fast ACTION_MODEL. */
  model?: string;
  /** Marks a code-seeded action; user-created actions omit this. */
  seeded?: boolean;
  createdBy: string;
  createdAt: string;
  lastRunAt?: string;
  lastRunSessionId?: string;
}

// ── Storage ──────────────────────────────────────────────────

function ensureDir() {
  mkdirSync(ACTIONS_DIR, { recursive: true });
}

export function listActions(): Action[] {
  ensureDir();
  return readdirSync(ACTIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(`${ACTIONS_DIR}/${f}`, "utf8")) as Action;
      } catch {
        return null;
      }
    })
    .filter((a): a is Action => !!a)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getAction(id: string): Action | null {
  const path = `${ACTIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Action;
  } catch {
    return null;
  }
}

function saveAction(action: Action) {
  ensureDir();
  writeFileSync(`${ACTIONS_DIR}/${action.id}.json`, JSON.stringify(action, null, 2));
}

export function deleteAction(id: string): boolean {
  const path = `${ACTIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ── Validation + creation ────────────────────────────────────

function repoPathFor(repo: string): string | undefined {
  return REPO_PATHS[repo];
}

function sanitizeInputs(raw: unknown): ActionInput[] | { error: string } {
  if (!Array.isArray(raw)) return { error: "inputs must be an array" };
  const out: ActionInput[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (!r || typeof r !== "object") return { error: "each input must be an object" };
    const name = String((r as any).name || "").trim();
    if (!name) return { error: "each input needs a name" };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      return { error: `invalid input name "${name}" (use letters, digits, underscore)` };
    if (seen.has(name)) return { error: `duplicate input name "${name}"` };
    seen.add(name);
    const type = (r as any).type;
    const t: ActionInputType = ["text", "number", "select", "boolean"].includes(type)
      ? type
      : "text";
    out.push({
      name,
      label: (r as any).label ? String((r as any).label) : undefined,
      type: t,
      required: !!(r as any).required,
      default: (r as any).default != null ? String((r as any).default) : undefined,
      options: Array.isArray((r as any).options)
        ? (r as any).options.map(String)
        : undefined,
      hint: (r as any).hint ? String((r as any).hint) : undefined,
    });
  }
  return out;
}

export function createAction(
  body: Record<string, unknown>
): Action | { error: string } {
  const name = String(body.name || "").trim();
  if (!name) return { error: "name is required" };
  const repo = String(body.repo || "tella-fusion");
  const repoRoot = repoPathFor(repo);
  if (!repoRoot) return { error: `unknown repo "${repo}"` };
  const scriptPath = String(body.scriptPath || "").trim();
  if (!scriptPath) return { error: "scriptPath is required" };
  if (scriptPath.startsWith("/") || scriptPath.includes(".."))
    return { error: "scriptPath must be relative to the repo root and not contain .." };
  if (!existsSync(`${repoRoot}/${scriptPath}`))
    return { error: `script not found in ${repo}: ${scriptPath}` };
  const inputs = sanitizeInputs(body.inputs ?? []);
  if ("error" in inputs) return inputs;
  const argMode = body.argMode === "env" ? "env" : "positional";
  const model = body.model ? resolveModel(String(body.model))?.id : undefined;

  const action: Action = {
    id: `act-${randomUUIDv7()}`,
    name,
    description: body.description ? String(body.description) : undefined,
    repo,
    scriptPath,
    inputs,
    argMode,
    confirm: body.confirm !== false,
    model,
    createdBy: body.createdBy ? String(body.createdBy) : "Anonymous",
    createdAt: new Date().toISOString(),
  };
  saveAction(action);
  return action;
}

// ── Command + prompt building ────────────────────────────────

/** POSIX single-quote a value so it reaches the script as one literal argument. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Resolve + validate the user-supplied values against the action's inputs. */
function resolveValues(
  action: Action,
  values: Record<string, unknown>
): Array<{ input: ActionInput; value: string }> | { error: string } {
  const out: Array<{ input: ActionInput; value: string }> = [];
  for (const input of action.inputs) {
    let raw = values[input.name];
    if ((raw == null || raw === "") && input.default != null) raw = input.default;
    const value = raw == null ? "" : String(raw);
    if (input.required && !value.trim())
      return { error: `"${input.label || input.name}" is required` };
    if (input.type === "number" && value.trim() && Number.isNaN(Number(value)))
      return { error: `"${input.label || input.name}" must be a number` };
    out.push({ input, value });
  }
  return out;
}

function interpreterFor(scriptPath: string): string {
  if (scriptPath.endsWith(".js") || scriptPath.endsWith(".mjs") || scriptPath.endsWith(".cjs"))
    return "node";
  if (scriptPath.endsWith(".ts")) return "bun";
  if (scriptPath.endsWith(".py")) return "python3";
  if (scriptPath.endsWith(".rb")) return "ruby";
  return "bash";
}

function buildCommand(
  action: Action,
  resolved: Array<{ input: ActionInput; value: string }>
): string {
  const interp = interpreterFor(action.scriptPath);
  if (action.argMode === "env") {
    const env = resolved.map(({ input, value }) => `${input.name}=${shq(value)}`).join(" ");
    return `${env ? env + " " : ""}${interp} ${shq(action.scriptPath)}`;
  }
  const args = resolved.map(({ value }) => shq(value)).join(" ");
  return `${interp} ${shq(action.scriptPath)}${args ? " " + args : ""}`.trim();
}

function buildRunPrompt(action: Action, command: string): string {
  return [
    `You are running a saved Action: "${action.name}".`,
    action.description ? `\n${action.description}` : "",
    `\nRun EXACTLY this one command from the current directory, and nothing else:`,
    "\n```bash",
    command,
    "```",
    `\nThen report the result concisely: show the command's stdout and stderr, and state ` +
      `clearly whether it succeeded (exit code 0) or failed. Do NOT modify, create, or delete ` +
      `any files, do NOT commit, and do NOT run any other commands except this one (you may ` +
      `re-run it once if it fails for a transient reason). If it fails, show the full error.`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Running ──────────────────────────────────────────────────

/**
 * Fire an action run. Creates a real backstage session (fast model, code mode,
 * tella-fusion main checkout) that executes the script and reports the output.
 * Returns the new session id immediately; the run streams via the session's
 * transcript like any other session. Mirrors the automations runner.
 */
export function runAction(
  action: Action,
  values: Record<string, unknown>,
  user: string | undefined,
  onSessionCreated?: (sessionId: string) => void
): { sessionId: string } | { error: string } {
  const resolved = resolveValues(action, values);
  if ("error" in resolved) return resolved;
  const repoRoot = repoPathFor(action.repo);
  if (!repoRoot) return { error: `unknown repo "${action.repo}"` };
  if (!existsSync(`${repoRoot}/${action.scriptPath}`))
    return { error: `script no longer exists: ${action.scriptPath}` };

  const command = buildCommand(action, resolved);
  const prompt = buildRunPrompt(action, command);
  const bksId = `bks-${randomUUIDv7()}`;
  const startedAt = new Date();
  const model = action.model || ACTION_MODEL;

  void (async () => {
    let effectiveModel = model;
    let effectiveProvider = providerFor(model);
    const persist = (engineSessionId: string) => {
      const isCodex = effectiveProvider === "codex";
      const data: BackstageSessionFile = {
        id: bksId,
        claudeSessionId: isCodex ? "" : engineSessionId,
        ...(isCodex && engineSessionId ? { codexThreadId: engineSessionId } : {}),
        ...(effectiveModel ? { model: effectiveModel } : {}),
        branch: "",
        worktreeDir: repoRoot,
        createdBy: `${action.name} (action)`,
        createdAt: startedAt.toISOString(),
        lastActivity: new Date().toISOString(),
        title: `${action.name} — ${startedAt.toISOString().slice(0, 16).replace("T", " ")}`,
        mode: "code",
      };
      writeFileSync(`${SESSIONS_DIR}/${bksId}.json`, JSON.stringify(data, null, 2));
    };

    try {
      saveAction({ ...action, lastRunAt: startedAt.toISOString(), lastRunSessionId: bksId });
    } catch {}

    console.log(`[actions] Running "${action.name}" → ${bksId}: ${command}`);

    let engineSessionId = "";
    try {
      for await (const event of runAgent({
        prompt,
        cwd: repoRoot,
        mode: "code",
        model,
        // Action runs change prod state by design — only Stripe stays gated.
        confirmTools: STRIPE_CONFIRM_TOOLS,
        aws: true,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
        journal: { bksSessionId: bksId, kind: "action" },
      })) {
        if (event.type === "init") {
          engineSessionId = event.sessionId || "";
          if (event.provider) effectiveProvider = event.provider;
          if (event.model) effectiveModel = event.model;
          persist(engineSessionId);
          onSessionCreated?.(bksId);
        }
        if (event.type === "done") {
          engineSessionId = event.sessionId || engineSessionId;
          if (event.provider) effectiveProvider = event.provider;
          if (event.model) effectiveModel = event.model;
        }
      }
      persist(engineSessionId);
    } catch (e) {
      console.error(`[actions] "${action.name}" run failed:`, e);
    }
  })();

  return { sessionId: bksId };
}

// ── Script introspection (suggest inputs when registering) ───

/**
 * Scan a repo script for the args it reads — positional `$1..$9` and
 * `$VAR` / `${VAR}` — so the create form can pre-fill suggested inputs.
 */
export function introspectScript(
  repo: string,
  scriptPath: string
): { inputs: ActionInput[]; argMode: "positional" | "env" } | { error: string } {
  const repoRoot = repoPathFor(repo);
  if (!repoRoot) return { error: `unknown repo "${repo}"` };
  if (scriptPath.startsWith("/") || scriptPath.includes(".."))
    return { error: "scriptPath must be relative and not contain .." };
  const full = `${repoRoot}/${scriptPath}`;
  if (!existsSync(full)) return { error: `script not found: ${scriptPath}` };

  let src = "";
  try {
    src = readFileSync(full, "utf8");
  } catch (e: any) {
    return { error: `couldn't read script: ${e.message || e}` };
  }

  const positionals = new Set<number>();
  for (const m of src.matchAll(/\$([1-9])\b/g)) positionals.add(Number(m[1]));
  // Named vars the script reads, excluding common shell/env builtins.
  const SKIP = new Set(["PATH", "HOME", "PWD", "USER", "SHELL", "IFS", "PROFILE", "AWS_PROFILE"]);
  const named = new Set<string>();
  for (const m of src.matchAll(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g)) {
    if (!SKIP.has(m[1])) named.add(m[1]);
  }

  // Prefer positional if the script uses $1..$N; named vars are noisy in bash.
  if (positionals.size > 0) {
    const max = Math.max(...positionals);
    const inputs: ActionInput[] = [];
    for (let i = 1; i <= max; i++) {
      inputs.push({ name: `arg${i}`, label: `Argument ${i}`, type: "text", required: true });
    }
    return { inputs, argMode: "positional" };
  }
  if (named.size > 0) {
    return {
      inputs: [...named].map((n) => ({ name: n, label: n, type: "text", required: true })),
      argMode: "env",
    };
  }
  return { inputs: [], argMode: "positional" };
}

// ── Code-seeded actions ──────────────────────────────────────

/**
 * The make_*_editor.sh family: each grants a user EDITOR access to a story
 * across prod/stage/dev DynamoDB. Same form (one Story ID → $1), one action per
 * teammate. Create-if-absent so re-seeding never clobbers UI edits.
 */
const SEEDED_EDITORS = ["grant", "jaap", "john", "johnny", "kent", "louise", "michiel"];

export function ensureSeedActions() {
  ensureDir();
  const existing = listActions();
  const byScript = new Set(existing.map((a) => `${a.repo}:${a.scriptPath}`));

  for (const who of SEEDED_EDITORS) {
    const scriptPath = `packages/scripts/make_${who}_editor.sh`;
    const key = `tella-fusion:${scriptPath}`;
    if (byScript.has(key)) continue;
    if (!existsSync(`${TELLA_FUSION}/${scriptPath}`)) continue;
    const pretty = who.charAt(0).toUpperCase() + who.slice(1);
    const action: Action = {
      id: `act-seed-make-${who}-editor`,
      name: `Make ${pretty} editor`,
      description: `Grant ${pretty} EDITOR access to a story across prod/stage/dev.`,
      repo: "tella-fusion",
      scriptPath,
      inputs: [
        {
          name: "ID",
          label: "Story ID",
          type: "text",
          required: true,
          hint: "The STORY# id (without the STORY# prefix).",
        },
      ],
      argMode: "positional",
      confirm: true,
      seeded: true,
      createdBy: "seed",
      createdAt: new Date().toISOString(),
    };
    saveAction(action);
    console.log(`[actions] Seeded "${action.name}"`);
  }
}
