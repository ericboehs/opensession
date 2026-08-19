/**
 * The in-process MCP surface as data: every opensession-* server, who builds
 * it, which runs can see it, and a placeholder-context factory that returns
 * the REAL server so its tools can be listed over MCP.
 *
 * Why this exists: which tools an agent gets, and why, was only ever readable
 * by tracing interactive-mcp.ts, automations.ts, handlers.ts and goal-runner.ts
 * by hand. scripts/gen-catalogs.ts walks this table, talks tools/list to each
 * built server, and writes docs/generated/mcp-tools.md; a test regenerates the
 * catalog and fails when the committed file is stale, and a second test asserts
 * this table still matches the live wiring in interactive-mcp.ts.
 *
 * Two rules keep it honest:
 *
 *  - `build()` returns the SAME server the runtime builds, with placeholder
 *    context. Nothing here re-declares a tool, so a tool cannot be added to a
 *    server without appearing in the catalog. Handlers are never invoked by the
 *    generator (tools/list only), so the placeholder callbacks throw.
 *  - `runClasses` and `condition` are DECLARED, because "which runs get this
 *    server" lives in call sites, not in the server object.
 *    mcp-catalog.test.ts checks the declaration against
 *    interactiveMcpServers(), so a new interactive server fails the suite until
 *    it is listed here.
 *
 * This module deliberately does NOT import interactive-mcp.ts: that module
 * starts the run-rpc socket server as a load-time side effect, which a doc
 * generator must never do (it would unlink the live instance's socket).
 */

import type { InProcessMcpServer } from "./inprocess-mcp";
import { createAdminMcpServer } from "../agents/slack/admin-tools";
import { createAskUserMcpServer } from "../agents/slack/ask-tools";
import { createAssetsMcpServer } from "../agents/slack/assets-tools";
import { createGithubMcpServer } from "../agents/slack/github-tools";
import { createGoalSelfMcpServer, createGoalsMcpServer } from "../agents/slack/goal-tools";
import { createHumansMcpServer } from "../agents/slack/humans-tools";
import { createKeychainMcpServer } from "../agents/slack/keychain-tools";
import { createMemoryMcpServer } from "../agents/slack/memory-tools";
import { createPapercutsMcpServer } from "../agents/slack/papercuts-tools";
import { createPublishMcpServer } from "../agents/slack/publish-tools";
import { createReportMcpServer } from "../agents/slack/report-tools";
import { createReposMcpServer } from "../agents/slack/repos-tools";
import { createSearchMcpServer } from "../agents/slack/search-tools";
import { createSelfImproveMcpServer } from "../agents/slack/self-improve-tools";
import { createSessionsMcpServer } from "../agents/slack/sessions-tools";
import { createSlackComposeMcpServer } from "../agents/slack/slack-compose-tools";
import { createTodosMcpServer } from "../agents/slack/todos-tools";
import { createTurnMcpServer } from "../agents/slack/turn-tools";
import { createWalkthroughMcpServer } from "../agents/slack/walkthrough-tools";
import { createWorkflowsMcpServer } from "../agents/slack/workflow-tools";
import { createRunnersMcpServer } from "./runners-mcp";
import { createPortalsMcpServer } from "./portals-mcp";
import { createSelfDeployMcpServer } from "./self-deploy";
import { createWebMcpServer } from "./web-mcp";

/**
 * The classes of run that carry in-process servers. One entry per wiring site,
 * because that is the granularity the security model reasons about.
 */
export type RunClass =
  /** Web UI + native clients: interactiveMcpServers (interactive-mcp.ts). */
  | "interactive"
  /** Automation runs, and interactive resumes of automation-owned sessions. */
  | "automation"
  /** The Slack agent loop's per-run set (agents/slack/handlers.ts). */
  | "slack"
  /** Goal wakes (goal-runner.ts). */
  | "goal"
  /** Built here, wired into no run — a live registration with no call site. */
  | "unwired";

export interface CatalogVariant {
  /** How this build differs from the primary one, in one line. */
  label: string;
  runClasses: RunClass[];
  build: () => InProcessMcpServer;
}

export interface McpServerCatalogEntry {
  /** MCP server name; the model sees `mcp__<name>__<tool>`. */
  name: string;
  /** What it is for, one line. */
  summary: string;
  /** Module owning the tool definitions. */
  source: string;
  /** Call sites that hand the server to a run. */
  wiring: string[];
  runClasses: RunClass[];
  /** Availability condition beyond the run class (a flag, a toggle, a mode). */
  condition?: string;
  /** Anything a reader of the catalog would otherwise have to discover. */
  note?: string;
  /** The server as its PRIMARY run class builds it. */
  build: () => InProcessMcpServer;
  /** Other contexts that build a DIFFERENT tool set from the same module. */
  variants?: CatalogVariant[];
}

// ── Placeholder context ──────────────────────────────────────────────────────
//
// Fixed values, never the live instance's: the generated catalog has to be
// byte-identical on every checkout, so nothing here may read machine state.
// (Tool descriptions that interpolate config — the persona name, the default
// repo — are pinned by the generator's hermetic config instead; see
// scripts/gen-catalogs.ts.)

const SESSION_ID = "os-00000000-0000-7000-0000-000000000000";
const USER = "You";
const AUTOMATION = "Example automation";

/** Placeholder callbacks: the generator lists tools, it never calls them. */
function unused(what: string): never {
  throw new Error(`mcp-catalog placeholder context: ${what} is never called`);
}

export const MCP_SERVER_CATALOG: McpServerCatalogEntry[] = [
  {
    name: "opensession-sessions",
    summary: "See and steer other sessions, and spawn worker sessions.",
    source: "packages/core/opensession-server/src/agents/slack/sessions-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts", "packages/core/opensession-server/src/agents/slack/handlers.ts", "packages/core/opensession-server/src/server/automations.ts"],
    runClasses: ["interactive", "slack", "automation"],
    condition:
      "Automation runs get it ONLY with the human-set `selfImprove` flag, and then in the `automationSelf` build below.",
    note: "The control tools (answer/send/cancel/create) are gated on `isAdmin`; Slack passes isAdmin only for the configured trusted user.",
    build: () =>
      createSessionsMcpServer({ createdBy: USER, isAdmin: true, currentSessionId: SESSION_ID }),
    variants: [
      {
        label: "selfImprove automation (isAdmin: false, automationSelf: true)",
        runClasses: ["automation"],
        build: () =>
          createSessionsMcpServer({
            createdBy: `${AUTOMATION} (automation)`,
            isAdmin: false,
            automationSelf: true,
            currentSessionId: SESSION_ID,
          }),
      },
    ],
  },
  {
    name: "opensession-admin",
    summary: "Manage automations, MCP connections and channel memory.",
    source: "packages/core/opensession-server/src/agents/slack/admin-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts", "packages/core/opensession-server/src/agents/slack/handlers.ts"],
    runClasses: ["interactive", "slack"],
    note: "Automation and MCP-connection tools are gated on `isAdmin`; channel memory is not.",
    build: () =>
      createAdminMcpServer({
        channel: "opensession",
        userId: "opensession",
        isDM: false,
        isPrivate: false,
        createdBy: USER,
        isAdmin: true,
      }),
  },
  {
    name: "opensession-runners",
    summary: "Run bounded commands on trusted persistent machines (Runners).",
    source: "packages/core/opensession-server/src/server/runners-mcp.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    build: () => createRunnersMcpServer({ user: USER, sessionId: SESSION_ID }),
  },
  {
    name: "opensession-goals",
    summary: "Create and steer long-running, self-pacing goals.",
    source: "packages/core/opensession-server/src/agents/slack/goal-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    note: "create/update/delete/steer are gated on `isAdmin`.",
    build: () => createGoalsMcpServer({ createdBy: USER, isAdmin: true }),
  },
  {
    name: "opensession-search",
    summary: "Search and read the distilled record of past sessions.",
    source: "packages/core/opensession-server/src/agents/slack/search-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    build: () => createSearchMcpServer(),
  },
  {
    name: "opensession-self-deploy",
    summary: "Deploy this instance to a sha and restart the live server.",
    source: "packages/core/opensession-server/src/server/self-deploy.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Withheld from dev instances (isDevInstance()) — the script targets the production service and state.",
    build: () => createSelfDeployMcpServer({ user: USER }),
  },
  {
    name: "opensession-humans",
    summary: "Ask a teammate and fold their answer back into this session.",
    source: "packages/core/opensession-server/src/agents/slack/humans-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts", "packages/core/opensession-server/src/agents/slack/handlers.ts", "packages/core/opensession-server/src/server/goal-runner.ts"],
    runClasses: ["interactive", "slack", "goal"],
    condition: "Interactive runs need a session id (the answer routes back to it).",
    build: () => createHumansMcpServer({ sessionId: SESSION_ID, createdBy: USER, isAdmin: true }),
  },
  {
    name: "opensession-keychain",
    summary: "Borrow a teammate's credential for a stated purpose, with their approval.",
    source: "packages/core/opensession-server/src/agents/slack/keychain-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    build: () => createKeychainMcpServer({ sessionId: SESSION_ID, user: USER }),
  },
  {
    name: "opensession-publish",
    summary: "Publish a directory as a durable internal web app.",
    source: "packages/core/opensession-server/src/agents/slack/publish-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    build: () =>
      createPublishMcpServer({
        sessionId: SESSION_ID,
        user: USER,
        worktreeDir: () => undefined,
      }),
  },
  {
    name: "opensession-repos",
    summary: "Attach or switch repos, and link a PR to this session.",
    source: "packages/core/opensession-server/src/agents/slack/repos-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    build: () =>
      createReposMcpServer({
        sessionId: SESSION_ID,
        attach: () => unused("attach"),
        switchPrimary: () => unused("switchPrimary"),
        snapshot: () => null,
        repos: () => [{ id: "example", defaultBranch: "main", sharedCheckout: false }],
        linkPr: () => unused("linkPr"),
      }),
  },
  {
    name: "opensession-memory",
    summary: "Durable repo / user / team memory, shared with Slack channel memory.",
    source: "packages/core/opensession-server/src/agents/slack/memory-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    note: "Write tools are interactive-only; automation runs get read-only memory injected into their prompt instead.",
    build: () => createMemoryMcpServer({ user: USER, repos: () => ["example"] }),
  },
  {
    name: "opensession-web",
    summary: "Read a URL as text, search what was fetched, clone a GitHub repo. No web search.",
    source: "packages/core/opensession-server/src/server/web-mcp.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    build: () => createWebMcpServer({ sessionId: SESSION_ID }),
  },
  {
    name: "opensession-portals",
    summary: "Supervised HTTP/WebSocket services for this session's workspace.",
    source: "packages/core/opensession-server/src/server/portals-mcp.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    build: () =>
      createPortalsMcpServer({
        sessionId: SESSION_ID,
        worktreeDir: () => undefined,
        setDefaultPath: () => undefined,
        sandbox: async () => null,
        hasSandbox: () => false,
        runner: () => undefined,
      }),
  },
  {
    name: "opensession-walkthrough",
    summary: "Publish a walkthrough (video, before/after, writeup) onto the Review tab and the PR.",
    source: "packages/core/opensession-server/src/agents/slack/walkthrough-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    build: () => createWalkthroughMcpServer({ sessionId: SESSION_ID, by: USER }),
  },
  {
    name: "opensession-slack",
    summary: "Open an editable Slack composer — the human still presses Send.",
    source: "packages/core/opensession-server/src/agents/slack/slack-compose-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    build: () => createSlackComposeMcpServer({ sessionId: SESSION_ID }),
  },
  {
    name: "opensession-ask",
    summary: "Ask the human a blocking question (for engines with no native ask tool).",
    source: "packages/core/opensession-server/src/agents/slack/ask-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts", "packages/core/opensession-server/src/agents/slack/handlers.ts"],
    runClasses: ["interactive", "slack"],
    condition: "Needs a session id. claude-runner strips it so Claude keeps its native AskUserQuestion.",
    build: () => createAskUserMcpServer({ ask: () => unused("ask") }),
  },
  {
    name: "opensession-workflows",
    summary: "Deterministic agent fan-out from a model-authored script.",
    source: "packages/core/opensession-server/src/agents/slack/workflow-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts", "packages/core/opensession-server/src/server/automations.ts"],
    runClasses: ["interactive", "automation"],
    condition: "Automation runs get it ONLY with the human-set `workflows` flag.",
    note: "An automation's build passes its own mcpAllowlist + AUTOMATION_DENIED_TOOLS, so a script's mcp.* calls cannot widen the run's least-privilege surface. Same tools either way.",
    build: () =>
      createWorkflowsMcpServer({
        sessionId: SESSION_ID,
        user: USER,
        workspace: () => undefined,
      }),
  },
  {
    name: "opensession-assets",
    summary: "Per-session scratch assets, previewed in the Assets tab.",
    source: "packages/core/opensession-server/src/agents/slack/assets-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id. Works in read-only Ask mode — assets land outside the checkout.",
    build: () => createAssetsMcpServer({ sessionId: SESSION_ID }),
  },
  {
    name: "opensession-todos",
    summary: "The user's Desk todo list.",
    source: "packages/core/opensession-server/src/agents/slack/todos-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["interactive"],
    condition: "Needs a session id.",
    note: "Reminder times are described in the list owner's configured timezone.",
    build: () => createTodosMcpServer({ sessionId: SESSION_ID, user: USER }),
  },
  {
    name: "opensession-papercuts",
    summary: "Append-only friction log.",
    source: "packages/core/opensession-server/src/agents/slack/papercuts-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/interactive-mcp.ts", "packages/core/opensession-server/src/server/automations.ts"],
    runClasses: ["interactive", "automation"],
    condition: "Dropped when the session's repo opted out (Settings → Papercuts).",
    note: "One of the two deliberate automation exceptions in docs/security-model.md: append-only, reads nothing sensitive, no control surface.",
    build: () =>
      createPapercutsMcpServer({
        sessionId: SESSION_ID,
        runKind: "prompt",
        by: USER,
        defaults: () => ({}),
      }),
  },
  {
    name: "opensession-report",
    summary: "Publish this run's durable HTML report into the Reports view.",
    source: "packages/core/opensession-server/src/agents/slack/report-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/automations.ts"],
    runClasses: ["automation"],
    build: () =>
      createReportMcpServer({
        automationId: "example",
        automationName: AUTOMATION,
        sessionId: SESSION_ID,
      }),
  },
  {
    name: "opensession-turn",
    summary: "Say \"looked, nothing to report\" instead of ending on silence.",
    source: "packages/core/opensession-server/src/agents/slack/turn-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/automations.ts"],
    runClasses: ["automation"],
    note: "Held to the papercuts bar: reads nothing, controls nothing.",
    build: () => createTurnMcpServer({ turnKey: SESSION_ID }),
  },
  {
    name: "opensession-self",
    summary: "A self-improving automation reading and rewriting its OWN prompt.",
    source: "packages/core/opensession-server/src/agents/slack/self-improve-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/automations.ts"],
    runClasses: ["automation"],
    condition: "Only with the human-set `selfImprove` flag on that automation.",
    build: () =>
      createSelfImproveMcpServer({
        automationName: AUTOMATION,
        getOwn: () => null,
        updateOwnPrompt: () => unused("updateOwnPrompt"),
      }),
  },
  {
    name: "opensession-github",
    summary: "Trigger the PR behaviours (review / auto-fix / simplify / adversarial).",
    source: "packages/core/opensession-server/src/agents/slack/github-tools.ts",
    wiring: ["packages/core/opensession-server/src/agents/slack/handlers.ts"],
    runClasses: ["slack"],
    note: "Slack-loop only: it reports back into the originating Slack thread. Open Session sessions use the PR panel instead.",
    build: () => createGithubMcpServer({ requestedBy: "U0EXAMPLE" }),
  },
  {
    name: "opensession-goal-self",
    summary: "A running goal's own cadence controls and fact ledger.",
    source: "packages/core/opensession-server/src/agents/slack/goal-tools.ts",
    wiring: ["packages/core/opensession-server/src/server/goal-runner.ts", "packages/core/opensession-server/src/server/interactive-mcp.ts"],
    runClasses: ["goal"],
    condition: "Only on a session that carries a goalId.",
    note: "Deliberately NOT in SHARED_INPROCESS_SERVERS: goal wakes keep per-session engine servers, because the tool list is discovered once per directory instance.",
    build: () => createGoalSelfMcpServer("goal-example"),
  },
];

/** Catalog entries whose server a given run class can see. */
export function catalogFor(runClass: RunClass): McpServerCatalogEntry[] {
  return MCP_SERVER_CATALOG.filter(
    (e) =>
      e.runClasses.includes(runClass) ||
      e.variants?.some((v) => v.runClasses.includes(runClass)),
  );
}
