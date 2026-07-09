/**
 * Backstage instance configuration (docs/portability-audit.md).
 *
 * Single `~/.opensession/config.json` (dual-read fallback to `~/.backstage/
 * config.json`; path overridable via OPENSESSION_CONFIG, or the deprecated
 * BACKSTAGE_CONFIG),
 * read fresh per call with the sandbox/config.ts pattern: tolerant parse,
 * missing/invalid file → built-in defaults. The built-in defaults are today's
 * Tella values, so a host with no config file behaves byte-identically.
 *
 * Precedence per key: existing env var → config.json → built-in default.
 *
 * Sections `server`, `paths`, `repos`, `identity`, `persona.name` (personaName())
 * and `branding` (productName()/productMark()) are consumed today;
 * `integrations`, `policy`, and the rest of `persona` are parsed and typed but
 * not yet wired (next batches of the portability workstream). See
 * config.example.json at the repo root for the full schema.
 */

import { readFileSync, statSync } from "fs";
import { envAlias, statePath } from "./rename-compat";

const HOME = process.env.HOME || "/home/ubuntu";

function configPath(): string {
  return (
    envAlias("OPENSESSION_CONFIG", "BACKSTAGE_CONFIG") ||
    statePath(".opensession/config.json", ".backstage/config.json")
  );
}

// ---------------------------------------------------------------------------
// Config file shape (everything optional — absent keys fall to defaults)
// ---------------------------------------------------------------------------

export interface ServerSection {
  host?: string;
  port?: number;
  webhookPort?: number;
  /** Public web-UI base, e.g. "https://michael.taila5d766.ts.net/backstage". */
  publicBaseUrl?: string;
  /** Host previews are served from (Caddy-fronted). */
  previewHost?: string;
  /** Caddy admin API endpoint. */
  caddyAdmin?: string;
}

export interface PathsSection {
  claudeBin?: string;
  opencodeBin?: string;
  worktreesDir?: string;
  /** The tella-fusion `wt` worktree helper script. */
  wtScript?: string;
  mcpConfig?: string;
}

/** A `repos` entry in config.json — partial; merged over the built-in repo
 *  with the same id, or (with at least `repo`) adds a new one. */
export interface RepoSection {
  repo?: string;
  wtPrefix?: string;
  defaultBranch?: string;
  ghRepo?: string;
  sharedCheckout?: boolean;
  /** Marks this repo as the instance default (see defaultRepo()). */
  default?: boolean;
  previewCommand?: string;
  depsInstall?: string;
}

export interface TeamMember {
  /** Full display name (also the git author name). */
  name: string;
  /** Git author/committer email for commit attribution. */
  email?: string;
  /** Picker names / short aliases (lowercase), e.g. ["michiel"]. */
  aliases?: string[];
  slackId?: string;
  /** GitHub login. */
  github?: string;
  /** Emails their Linear account uses (may differ from the git email). */
  linearEmails?: string[];
  /**
   * Include in the GitHub→Slack notification map (GITHUB_TO_SLACK). Default
   * true when both `github` and `slackId` are set; set false to keep someone
   * out of GitHub-event Slack pings without dropping their other mappings.
   */
  githubToSlack?: boolean;
}

export interface IdentitySection {
  team?: TeamMember[];
  /** Extra Slack id → display name entries (bots, legacy workspace ids) that
   *  aren't full team members. */
  slackNames?: Record<string, string>;
}

/** Parsed but not yet consumed — batch "integration fail-closed gating". */
export interface IntegrationsSection {
  [integration: string]: unknown;
}

/** Parsed but not yet consumed — optional policy overrides. */
export interface PolicySection {
  stripeConfirmTools?: string[];
  automationDeniedTools?: string[];
}

/** Persona copy in prompt builders. `name` is consumed (personaName());
 *  `company`/`product` are parsed but not yet wired (persona batch 2). */
export interface PersonaSection {
  name?: string;
  company?: string;
  product?: string;
}

/** Instance branding — what the *platform itself* is called in the UI
 *  (distinct from persona: `persona.name` is the agent, `persona.product`
 *  is the company's product the agent supports). */
export interface BrandingSection {
  /** Product name rendered in titles/headers, e.g. "Backstage". */
  productName?: string;
  /** Short visual monogram for brand-mark contexts (logo chip, favicon);
   *  defaults to productName. */
  productMark?: string;
}

export interface BackstageConfig {
  server?: ServerSection;
  paths?: PathsSection;
  repos?: Record<string, RepoSection>;
  identity?: IdentitySection;
  integrations?: IntegrationsSection;
  policy?: PolicySection;
  persona?: PersonaSection;
  branding?: BrandingSection;
}

// ---------------------------------------------------------------------------
// Resolved shapes (defaults applied)
// ---------------------------------------------------------------------------

// The *repo* concept sessions run against (moved here from worktree.ts so the
// registry can be config-driven; worktree.ts re-exports the type). Worktrees
// live at <worktreesDir>/<wtPrefix>-<branch>; defaultBranch is the base they
// branch from.
//
// NOTE: a "Project" in the UI is a separate thing — an optional folder that
// groups chats (see src/server/projects.ts). A chat's worktree lives on the
// chat and belongs to one of these repos.
export interface Repo {
  id: string;
  repo: string;
  wtPrefix: string;
  defaultBranch: string;
  /** GitHub `owner/name` for PR operations (gh CLI). */
  ghRepo: string;
  // When true, code sessions run directly in the main checkout on the default
  // branch instead of an isolated worktree. Backstage is self-hosting — the live
  // server runs `bun --hot` from its main checkout, so editing there is the only
  // way a change is testable without a second instance. Sessions share one tree
  // and commit straight to the default branch (see "Backstage dev workflow" in
  // CLAUDE.md: add → commit → push, never reset/discard the shared repo).
  sharedCheckout?: boolean;
  /** Instance default repo (defaultRepo()); unset built-ins fall back to tella-fusion. */
  default?: boolean;
  /** Dev-server bring-up command for previews. Carried on the type for the
   *  preview layer to consume; not read anywhere yet. */
  previewCommand?: string;
  /** Shell command (run with cwd = the fresh worktree) that installs deps.
   *  Unset = worktree.ts's built-in behavior (tella-fusion webapp install /
   *  root `bun install` when a package.json exists). */
  depsInstall?: string;
}

export interface ResolvedServer {
  host: string;
  port: number;
  webhookPort: number;
  publicBaseUrl: string;
  previewHost: string;
  caddyAdmin: string;
}

export interface ResolvedPaths {
  claudeBin: string;
  opencodeBin: string | null;
  worktreesDir: string;
  wtScript: string;
  mcpConfig: string;
}

export interface ResolvedIdentity {
  team: TeamMember[];
  slackNames: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Built-in Tella defaults (behavior with no config file must equal these)
// ---------------------------------------------------------------------------

function builtinRepos(): Record<string, Repo> {
  return {
    "tella-fusion": {
      id: "tella-fusion",
      repo: "/home/ubuntu/projects/tella-fusion",
      wtPrefix: "tella-fusion",
      defaultBranch: "main",
      ghRepo: "tellahq/tella-fusion",
      previewCommand: "/home/ubuntu/.claude/skills/tella-local/ensure-up.sh",
    },
    backstage: {
      id: "backstage",
      repo: "/home/ubuntu/projects/tella-backstage",
      wtPrefix: "backstage",
      defaultBranch: "master",
      ghRepo: "tellahq/backstage",
      sharedCheckout: true,
    },
    // Infra / GitOps / media repos — normal worktree + PR flow (none self-host).
    gitops: { id: "gitops", repo: "/home/ubuntu/projects/gitops", wtPrefix: "gitops", defaultBranch: "main", ghRepo: "tellahq/gitops" },
    infra: { id: "infra", repo: "/home/ubuntu/projects/infra", wtPrefix: "infra", defaultBranch: "main", ghRepo: "tellahq/infra" },
    "shared-infra": { id: "shared-infra", repo: "/home/ubuntu/projects/shared-infra", wtPrefix: "shared-infra", defaultBranch: "main", ghRepo: "tellahq/shared-infra" },
    gstreamer: { id: "gstreamer", repo: "/home/ubuntu/projects/gstreamer", wtPrefix: "gstreamer", defaultBranch: "tla_main", ghRepo: "tellahq/gstreamer" },
    "gst-plugins-rs": { id: "gst-plugins-rs", repo: "/home/ubuntu/projects/gst-plugins-rs", wtPrefix: "gst-plugins-rs", defaultBranch: "tla_main", ghRepo: "tellahq/gst-plugins-rs" },
  };
}

/**
 * Tella's roster, expressed as the identity config that derives today's
 * user-mappings tables exactly (user-mappings.test.ts pins that equality).
 * `githubToSlack: false` on Louise mirrors the historical GITHUB_TO_SLACK
 * table, which never listed her — keep it that way so converting the table to
 * config changes zero behavior.
 */
const DEFAULT_TEAM: TeamMember[] = [
  { name: "Michiel Westerbeek", email: "happylinks@gmail.com", aliases: ["michiel"], slackId: "UT41L6GCC", github: "happylinks", linearEmails: ["michiel@tella.tv"] },
  { name: "Jaap Frolich", email: "jfrolich@gmail.com", aliases: ["jaap"], slackId: "U08EWERLX8D", github: "jfrolich", linearEmails: ["jaap@tella.com"] },
  { name: "Kent de Bruin", email: "52224550+kentdebruin@users.noreply.github.com", aliases: ["kent"], slackId: "U08S8B3P83X", github: "kentdebruin", linearEmails: ["kent@tella.com"] },
  { name: "Grant Shaddick", email: "grant@tella.com", aliases: ["grant"], slackId: "USU9S2YRF", github: "9ranty", linearEmails: ["grant@tella.tv"] },
  { name: "Johnny Lin", email: "67078496+johnnylinsf@users.noreply.github.com", aliases: ["johnny"], slackId: "U0866D7PCCU", github: "johnnylinsf", linearEmails: ["johnny@tella.tv"] },
  { name: "John Soutar", email: "john@tella.com", aliases: ["john"], slackId: "U08CXTV7ML2", github: "soutar", linearEmails: ["john@tella.com"] },
  { name: "Louise de Sadeleer", email: "54376811+louisedesadeleer@users.noreply.github.com", aliases: ["louise"], slackId: "U08JGAT5KNK", github: "louisedesadeleer", linearEmails: ["louise@tella.com"], githubToSlack: false },
  { name: "Thibault Saunier", email: "tsaunier@igalia.com", aliases: ["thibault"], slackId: "U065GD4757C", github: "thiblahute", linearEmails: ["tsaunier@igalia.com"] },
];

/** Slack ids that resolve to a display name but aren't full team members —
 *  bots, contractors, and legacy-workspace ids. */
const DEFAULT_SLACK_NAMES: Record<string, string> = {
  U066K2VRDHA: "Andres Gomez",
  U0A3CERFC57: "Connor",
  U0A3PB2MJET: "Ankita Kulkarni",
  U0A7T08405R: "Michael",
  U03EACNTLA1: "Linear",
  // Legacy workspace ids
  U01D3KX3ATW: "Johnny",
  U01E8UE6L15: "Louise",
  U084XSXRQNB: "Kent",
  U086HCZURPM: "Grant",
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const bool = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

/** Drop undefined values so spreading a partial never clobbers a default. */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function parseRepoSection(v: unknown): RepoSection | undefined {
  const o = obj(v);
  if (!o) return undefined;
  return defined({
    repo: str(o.repo),
    wtPrefix: str(o.wtPrefix),
    defaultBranch: str(o.defaultBranch),
    ghRepo: str(o.ghRepo),
    sharedCheckout: bool(o.sharedCheckout),
    default: bool(o.default),
    previewCommand: str(o.previewCommand),
    depsInstall: str(o.depsInstall),
  });
}

function parseTeamMember(v: unknown): TeamMember | undefined {
  const o = obj(v);
  const name = str(o?.name);
  if (!o || !name) return undefined;
  return {
    name,
    ...defined({
      email: str(o.email),
      aliases: strArray(o.aliases),
      slackId: str(o.slackId),
      github: str(o.github),
      linearEmails: strArray(o.linearEmails),
      githubToSlack: bool(o.githubToSlack),
    }),
  };
}

function parseConfig(text: string): BackstageConfig {
  try {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const cfg: BackstageConfig = {};

    const server = obj(raw.server);
    if (server) {
      cfg.server = defined({
        host: str(server.host),
        port: num(server.port),
        webhookPort: num(server.webhookPort),
        publicBaseUrl: str(server.publicBaseUrl),
        previewHost: str(server.previewHost),
        caddyAdmin: str(server.caddyAdmin),
      });
    }

    const paths = obj(raw.paths);
    if (paths) {
      cfg.paths = defined({
        claudeBin: str(paths.claudeBin),
        opencodeBin: str(paths.opencodeBin),
        worktreesDir: str(paths.worktreesDir),
        wtScript: str(paths.wtScript),
        mcpConfig: str(paths.mcpConfig),
      });
    }

    const repos = obj(raw.repos);
    if (repos) {
      const parsed: Record<string, RepoSection> = {};
      for (const [id, entry] of Object.entries(repos)) {
        const r = parseRepoSection(entry);
        if (r) parsed[id] = r;
      }
      cfg.repos = parsed;
    }

    const identity = obj(raw.identity);
    if (identity) {
      const section: IdentitySection = {};
      if (Array.isArray(identity.team)) {
        section.team = identity.team
          .map(parseTeamMember)
          .filter((m): m is TeamMember => !!m);
      }
      const names = obj(identity.slackNames);
      if (names) {
        section.slackNames = Object.fromEntries(
          Object.entries(names).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>;
      }
      cfg.identity = section;
    }

    // Not consumed yet — carried through so the next batches have the data.
    const integrations = obj(raw.integrations);
    if (integrations) cfg.integrations = integrations;
    const policy = obj(raw.policy);
    if (policy) {
      cfg.policy = defined({
        stripeConfirmTools: strArray(policy.stripeConfirmTools),
        automationDeniedTools: strArray(policy.automationDeniedTools),
      });
    }
    const persona = obj(raw.persona);
    if (persona) {
      cfg.persona = defined({
        name: str(persona.name),
        company: str(persona.company),
        product: str(persona.product),
      });
    }
    const branding = obj(raw.branding);
    if (branding) {
      cfg.branding = defined({
        productName: str(branding.productName),
        productMark: str(branding.productMark),
      });
    }

    return cfg;
  } catch {
    return {};
  }
}

// Read fresh per call, with an mtime/size guard so hot paths (the REPOS proxy
// in worktree.ts hits this on every property access) don't re-parse an
// unchanged file. Missing/unreadable/invalid file = {} = built-in defaults.
let cache: { path: string; mtimeMs: number; size: number; value: BackstageConfig } | null = null;

/** Raw config.json contents (typed, tolerant). Never throws. */
export function getConfig(): BackstageConfig {
  const path = configPath();
  try {
    const st = statSync(path);
    if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.value;
    }
    const value = parseConfig(readFileSync(path, "utf-8"));
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, value };
    return value;
  } catch {
    cache = null;
    return {};
  }
}

// ---------------------------------------------------------------------------
// Typed getters (env var → config.json → built-in Tella default)
// ---------------------------------------------------------------------------

export function configuredServer(): ResolvedServer {
  const s = getConfig().server || {};
  const envPort = parseInt(process.env.PORT || "");
  const envWebhookPort = parseInt(process.env.WEBHOOK_PORT || "");
  return {
    host: process.env.HOST || s.host || "127.0.0.1",
    port: Number.isFinite(envPort) ? envPort : s.port ?? 3850,
    webhookPort: Number.isFinite(envWebhookPort) ? envWebhookPort : s.webhookPort ?? 3848,
    // Built-in default stays on /backstage until the operator flips
    // OPENSESSION_UI_BASE (or config publicBaseUrl) in the rename restart
    // window — the /backstage alias path keeps every old link working forever.
    publicBaseUrl:
      envAlias("OPENSESSION_UI_BASE", "MICHAEL_UI_BASE") ||
      s.publicBaseUrl ||
      "https://michael.taila5d766.ts.net/backstage",
    previewHost: process.env.PREVIEW_HOST || s.previewHost || "michael.taila5d766.ts.net",
    caddyAdmin: s.caddyAdmin || "http://localhost:2019",
  };
}

export function configuredPaths(): ResolvedPaths {
  const p = getConfig().paths || {};
  return {
    claudeBin: envAlias("OPENSESSION_CLAUDE_BIN", "BACKSTAGE_CLAUDE_BIN") || p.claudeBin || "/home/ubuntu/.local/bin/claude",
    opencodeBin: envAlias("OPENSESSION_OPENCODE_BIN", "BACKSTAGE_OPENCODE_BIN") || p.opencodeBin || null,
    worktreesDir: envAlias("OPENSESSION_WORKTREES_DIR", "BACKSTAGE_WORKTREES_DIR") || p.worktreesDir || "/home/ubuntu/worktrees",
    wtScript: p.wtScript || "/home/ubuntu/bin/wt",
    mcpConfig: envAlias("OPENSESSION_MCP_CONFIG", "BACKSTAGE_MCP_CONFIG") || p.mcpConfig || `${HOME}/projects/tella-backstage/mcp-config.json`,
  };
}

/**
 * The repo registry: config `repos` merged over the built-in Tella map.
 * A config entry with a built-in id overrides just the fields it sets; a new
 * id (with at least `repo`) adds a repo. OPENSESSION_TELLA_FUSION (or the
 * deprecated BACKSTAGE_TELLA_FUSION) keeps env precedence over both for the
 * tella-fusion checkout path.
 */
export function configuredRepos(): Record<string, Repo> {
  const merged = builtinRepos();
  for (const [id, entry] of Object.entries(getConfig().repos || {})) {
    const base = merged[id];
    if (base) {
      merged[id] = { ...base, ...entry, id };
    } else {
      if (!entry.repo) continue; // a new repo needs a checkout path
      merged[id] = {
        id,
        repo: entry.repo,
        wtPrefix: entry.wtPrefix || id,
        defaultBranch: entry.defaultBranch || "main",
        ghRepo: entry.ghRepo || "",
        ...defined({
          sharedCheckout: entry.sharedCheckout,
          default: entry.default,
          previewCommand: entry.previewCommand,
          depsInstall: entry.depsInstall,
        }),
      };
    }
  }
  const envTellaFusion = envAlias("OPENSESSION_TELLA_FUSION", "BACKSTAGE_TELLA_FUSION");
  if (envTellaFusion && merged["tella-fusion"]) {
    merged["tella-fusion"] = { ...merged["tella-fusion"], repo: envTellaFusion };
  }
  return merged;
}

/** The instance's default repo: the entry flagged `default: true` in config,
 *  falling back to tella-fusion (always present via the built-ins). */
export function defaultRepo(): Repo {
  const repos = configuredRepos();
  return (
    Object.values(repos).find((r) => r.default) ||
    repos["tella-fusion"] ||
    Object.values(repos)[0]
  );
}

/**
 * The agent's name as rendered to users and models (system prompts, Slack
 * greetings, confirm cards, health payloads). NOT for protocol identifiers —
 * `michael-*` MCP server ids, MICHAEL_* env vars, ===MICHAEL-SUMMARY===
 * markers stay literal (renaming those breaks running sessions).
 */
export function personaName(): string {
  return getConfig().persona?.name || "Michael";
}

/**
 * What the platform itself is called in user-facing copy (page titles,
 * headers). NOT for paths/ids: state dirs, env vars, `bks-` prefixes and
 * service/socket names go through the rename-compat alias layer instead
 * (docs/rename-opensession-plan.md).
 */
export function productName(): string {
  return getConfig().branding?.productName || "Backstage";
}

/** Short brand monogram for visual brand-mark contexts (logo chip, favicon);
 *  falls back to the full product name. */
export function productMark(): string {
  return getConfig().branding?.productMark || productName();
}

/**
 * Identity roster for user-mappings.ts. No `identity` section = Tella's
 * built-in roster (behavior-identical); an `identity` section present but
 * with an empty/absent team = genuinely empty tables (attribution/gating
 * become no-ops, by design).
 */
export function configuredIdentity(): ResolvedIdentity {
  const id = getConfig().identity;
  if (!id) return { team: DEFAULT_TEAM, slackNames: DEFAULT_SLACK_NAMES };
  return { team: id.team ?? [], slackNames: id.slackNames ?? {} };
}
