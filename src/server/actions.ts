/**
 * Actions: a quick way to run a registered repo script behind a form.
 *
 * An Action = (1) an input form + (2) a way to execute a script. v1 registers
 * existing scripts that live in a repo (e.g. scripts/run-maintenance.sh)
 * and maps the form fields to the script's arguments. A run is NOT a bespoke
 * output panel — it spins up a real backstage session on a fast/cheap model
 * (Haiku) that executes the command and reports the output, so it shows up in
 * the sessions list with a transcript and can be forked into a full session to
 * dig in. (Inline js/bash scripts authored in the UI come in a later version.)
 *
 * Records live in ~/.opensession-actions/<id>.json. The make_*_editor.sh family
 * is code-seeded (create-if-absent) so the actions exist without a data import
 * and UI edits are preserved.
 */
import { randomUUIDv7 } from "bun";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, existsSync } from "fs";
import { writeJsonAtomic } from "./shared/atomic-write";
import { runAgent } from "./agent-runner";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";
import { providerFor, resolveModel, DEFAULT_FALLBACK_MODEL, modelLabel } from "./models";
import { engineSessionPatch } from "./sessions";
import { updateSessionFile } from "./session-cache";
import type { BackstageSessionFile } from "./types";
import { configuredIntegration, configuredRepos, defaultRepo } from "./config";
import { stateDir } from "./rename-compat";
import { shouldPersistModelSwitch } from "./run-events";

const ACTIONS_DIR = stateDir("actions");

/** Fast/cheap model for action runs (the LLM only orchestrates one Bash call). */
const ACTION_MODEL = "claude-haiku-4-5";

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
  /**
   * How the action executes:
   *  - "repo": run a script that lives in a repo (positional/env args).
   *  - "mcp": call a single MCP tool with the form values as its arguments —
   *    the tool runs on its own server with its own credentials, so privileged
   *    ops (e.g. the support MCP's grant_story_editor) don't need the agent's
   *    sandboxed AWS creds. Omitted = "repo" (back-compat).
   */
  kind?: "repo" | "mcp";
  /** repo: the repo the script lives in. v1: always the default repo (repoPathFor). */
  repo?: string;
  /** repo: script path relative to the repo root, e.g. "scripts/run-maintenance.sh". */
  scriptPath?: string;
  /** repo: how input values reach the script. positional = bash x a b; env = A=a B=b bash x. */
  argMode?: "positional" | "env";
  /** mcp: the MCP server to enable for the run, e.g. "support". */
  mcpServer?: string;
  /** mcp: the tool to call on that server, e.g. "grant_story_editor". */
  toolName?: string;
  /** Form fields. For "repo": ordered args. For "mcp": each name = the tool arg name. */
  inputs: ActionInput[];
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
  writeJsonAtomic(`${ACTIONS_DIR}/${action.id}.json`, action);
}

export function deleteAction(id: string): boolean {
  const path = `${ACTIONS_DIR}/${id}.json`;
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// ── Validation + creation ────────────────────────────────────

function repoPathFor(repo: string): string | undefined {
  return configuredRepos()[repo]?.repo;
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
  const inputs = sanitizeInputs(body.inputs ?? []);
  if ("error" in inputs) return inputs;
  const model = body.model ? resolveModel(String(body.model))?.id : undefined;
  const kind = body.kind === "mcp" ? "mcp" : "repo";

  const base = {
    id: `act-${randomUUIDv7()}`,
    name,
    description: body.description ? String(body.description) : undefined,
    inputs,
    confirm: body.confirm !== false,
    model,
    createdBy: body.createdBy ? String(body.createdBy) : "Anonymous",
    createdAt: new Date().toISOString(),
  };

  if (kind === "mcp") {
    const mcpServer = String(body.mcpServer || "").trim();
    if (!mcpServer) return { error: "mcpServer is required for an MCP action" };
    const toolName = String(body.toolName || "").trim();
    if (!toolName) return { error: "toolName is required for an MCP action" };
    const action: Action = { ...base, kind: "mcp", mcpServer, toolName };
    saveAction(action);
    return action;
  }

  const repo = String(body.repo || defaultRepo().id);
  const repoRoot = repoPathFor(repo);
  if (!repoRoot) return { error: `unknown repo "${repo}"` };
  const scriptPath = String(body.scriptPath || "").trim();
  if (!scriptPath) return { error: "scriptPath is required" };
  if (scriptPath.startsWith("/") || scriptPath.includes(".."))
    return { error: "scriptPath must be relative to the repo root and not contain .." };
  if (!existsSync(`${repoRoot}/${scriptPath}`))
    return { error: `script not found in ${repo}: ${scriptPath}` };
  const argMode = body.argMode === "env" ? "env" : "positional";

  const action: Action = { ...base, kind: "repo", repo, scriptPath, argMode };
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
  const scriptPath = action.scriptPath || "";
  const interp = interpreterFor(scriptPath);
  if (action.argMode === "env") {
    const env = resolved.map(({ input, value }) => `${input.name}=${shq(value)}`).join(" ");
    return `${env ? env + " " : ""}${interp} ${shq(scriptPath)}`;
  }
  const args = resolved.map(({ value }) => shq(value)).join(" ");
  return `${interp} ${shq(scriptPath)}${args ? " " + args : ""}`.trim();
}

/** Coerce resolved form values to a JSON args object for an MCP tool call. */
function buildMcpArgs(
  resolved: Array<{ input: ActionInput; value: string }>
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const { input, value } of resolved) {
    if (value === "" && !input.required) continue;
    if (input.type === "number") args[input.name] = value === "" ? value : Number(value);
    else if (input.type === "boolean") args[input.name] = value === "true";
    else args[input.name] = value;
  }
  return args;
}

function buildMcpPrompt(
  action: Action,
  resolved: Array<{ input: ActionInput; value: string }>
): string {
  const args = buildMcpArgs(resolved);
  return [
    `You are running a saved Action: "${action.name}".`,
    action.description ? `\n${action.description}` : "",
    `\nCall the MCP tool \`${action.toolName}\` on the \`${action.mcpServer}\` server ` +
      `EXACTLY once, with these arguments:`,
    "\n```json",
    JSON.stringify(args, null, 2),
    "```",
    `\nDo NOT call any other tool and do NOT modify anything else. After it returns, report the ` +
      `result concisely — whether it performed the change or refused, and the effect. If the tool ` +
      `is unavailable, say so clearly rather than improvising another approach.`,
  ]
    .filter(Boolean)
    .join("\n");
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
 * default repository checkout) that executes the script and reports the output.
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

  // Build the run prompt + the cwd + the MCP allowlist per execution kind.
  let prompt: string;
  let mcpServers: string[] | undefined;
  let cwd = defaultRepo().repo;
  let useAws = false;
  if (action.kind === "mcp") {
    if (!action.mcpServer || !action.toolName)
      return { error: "MCP action is missing mcpServer/toolName" };
    prompt = buildMcpPrompt(action, resolved);
    mcpServers = [action.mcpServer]; // least privilege: only the server it needs
  } else {
    const repoRoot = repoPathFor(action.repo || defaultRepo().id);
    if (!repoRoot) return { error: `unknown repo "${action.repo}"` };
    if (!action.scriptPath || !existsSync(`${repoRoot}/${action.scriptPath}`))
      return { error: `script no longer exists: ${action.scriptPath}` };
    prompt = buildRunPrompt(action, buildCommand(action, resolved));
    cwd = repoRoot;
    useAws = true; // scripts may shell out to aws (limited to the instance role)
  }

  const bksId = `bks-${randomUUIDv7()}`;
  const startedAt = new Date();
  const model = action.model || ACTION_MODEL;

  void (async () => {
    let effectiveModel = model;
    let selectedModel = model;
    let effectiveProvider = providerFor(model);
    const modelHistory: NonNullable<BackstageSessionFile["modelHistory"]> = [];
    // Field-scoped write: creation fields are create-if-absent defaults (an
    // existing file wins); this run only ever owns the engine-id/model
    // tracking fields it actually changes. Serialized via updateSessionFile.
    const persist = (engineSessionId: string) =>
      updateSessionFile(bksId, (data) => {
        // Widen to Partial: the file may not exist yet (create-if-absent).
        const existing: Partial<BackstageSessionFile> = data;
        return {
          id: bksId,
          claudeSessionId: "",
          branch: "",
          worktreeDir: cwd,
          createdBy: `${action.name} (action)`,
          createdAt: startedAt.toISOString(),
          title: `${action.name} — ${startedAt.toISOString().slice(0, 16).replace("T", " ")}`,
          mode: "code" as const,
          ...existing,
          ...(engineSessionId
            ? engineSessionPatch(effectiveProvider, engineSessionId)
            : {}),
          ...(engineSessionId ? { lastEngineProvider: effectiveProvider } : {}),
          ...(effectiveModel ? { lastEngineModel: effectiveModel } : {}),
          ...(selectedModel ? { model: selectedModel } : {}),
          ...(modelHistory.length ? { modelHistory } : {}),
          lastActivity: new Date().toISOString(),
        };
      });

    try {
      saveAction({ ...action, lastRunAt: startedAt.toISOString(), lastRunSessionId: bksId });
    } catch {}

    console.log(
      `[actions] Running "${action.name}" → ${bksId} (${
        action.kind === "mcp" ? `${action.mcpServer}.${action.toolName}` : action.scriptPath
      })`
    );

    let engineSessionId = "";
    try {
      for await (const event of runAgent({
        prompt,
        cwd,
        mode: "code",
        model,
        mcpServers: mcpServers ?? "all",
        // Action runs change prod state by design — only Stripe stays gated.
        confirmTools: STRIPE_CONFIRM_TOOLS,
        aws: useAws,
        fallbackModel: DEFAULT_FALLBACK_MODEL,
        journal: { bksSessionId: bksId, kind: "action" },
      })) {
        if (event.type === "init") {
          engineSessionId = event.sessionId || "";
          if (event.provider) effectiveProvider = event.provider;
          if (event.model) effectiveModel = event.model;
          await persist(engineSessionId);
          onSessionCreated?.(bksId);
        }
        if (event.type === "model_switch") {
          const to = event.toModel || "";
          if (to) {
            effectiveModel = to;
            effectiveProvider = providerFor(to);
            if (shouldPersistModelSwitch(event)) {
              selectedModel = to;
              modelHistory.push({
                model: to,
                at: new Date().toISOString(),
                by: `auto-switch — ${modelLabel(event.fromModel)} ${event.switchReason || "out of credits"}`,
              });
            }
          }
        }
        if (event.type === "done") {
          engineSessionId = event.sessionId || engineSessionId;
          if (event.provider) effectiveProvider = event.provider;
          if (event.model) effectiveModel = event.model;
        }
      }
      await persist(engineSessionId);
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

// ── Config-seeded actions ──────────────────────────────────────

/**
 * Seed actions are deployment data, not application code. Define them as full
 * Action-shaped objects under `integrations.seeds.actions`; create-if-absent
 * preserves any edits made later through the UI.
 */
export function ensureSeedActions() {
  ensureDir();
  const raw = configuredIntegration("seeds").actions;
  if (!Array.isArray(raw)) return;
  for (const candidate of raw) {
    if (!candidate || typeof candidate !== "object") continue;
    const value = candidate as Partial<Action>;
    if (
      typeof value.id !== "string" ||
      typeof value.name !== "string" ||
      (value.kind !== "repo" && value.kind !== "mcp")
    ) continue;
    if (getAction(value.id)) continue;
    const action: Action = {
      ...(value as Action),
      seeded: true,
      createdBy: value.createdBy || "config",
      createdAt: value.createdAt || new Date().toISOString(),
      inputs: Array.isArray(value.inputs) ? value.inputs : [],
      confirm: value.confirm !== false,
    };
    saveAction(action);
    console.log(`[actions] Seeded configured action "${action.name}"`);
  }
}
