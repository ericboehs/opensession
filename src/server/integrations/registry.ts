/**
 * The integration registry: one declarative entry per optional integration.
 *
 * Before this existed, every integration was an if-block hand-written into
 * `loadAgents()` in opensession.ts, and its environment variables were
 * documented only in prose. That made three things awkward: onboarding could
 * not enumerate integrations, `opensession doctor` could not tell you which
 * credentials were missing, and adding one meant editing the entry file that
 * every parallel session is already touching.
 *
 * Each entry owns its identity (config key + env flag), its credentials, and
 * how to construct its agent. `loadAgents()` is now a loop over this array.
 *
 * Adding an integration: append an entry here. Nothing in opensession.ts
 * changes. This is a boot path, so it needs a real `systemctl restart`.
 *
 * ARRAY ORDER IS BOOT ORDER. It matches the original hand-written sequence
 * (plain, tella, linear, slack, stripe, grafana, github) so that agent
 * registration — including webhook route registration — happens in exactly the
 * order it always has. Present them in a friendlier order in UI if you like,
 * but do not reshuffle this array casually.
 *
 * Other invariants preserved from the original blocks:
 *  - a failing import logs and is skipped; it never takes the server down
 *  - `always: true` modules load regardless of config and self-gate internally
 *  - `requires` is an extra runtime gate on top of the enable flag
 */

import type { AgentModule } from "../../agents/types";

/** Passed to integrations that need to poke core state when they act. */
export type IntegrationContext = {
  onSessionInvalidate: () => void;
};

export type IntegrationEnv = {
  name: string;
  /** Placeholder written into a generated env file. */
  example?: string;
  /** Without this the integration cannot function at all. */
  required?: boolean;
  description: string;
};

export type IntegrationSpec = {
  /** Config key under `integrations.` and the id used by the CLI. */
  id: string;
  label: string;
  /** Doc path, surfaced by onboarding and in the generated env file. */
  doc: string;
  enableFlag: string;
  env: IntegrationEnv[];
  /** Load regardless of configuration; the module gates itself. */
  always?: boolean;
  /** Extra gate beyond the enable flag — checked at load time. */
  requires?: () => boolean;
  load: (ctx: IntegrationContext) => Promise<AgentModule>;
};

export const INTEGRATIONS: IntegrationSpec[] = [
  {
    id: "plain",
    label: "Plain",
    doc: "docs/setup/plain.md",
    enableFlag: "ENABLE_PLAIN_AGENT",
    env: [
      { name: "PLAIN_API_KEY", required: true, description: "API key for thread reads/writes" },
      { name: "PLAIN_WEBHOOK_SECRET", description: "verifies inbound webhook signatures" },
    ],
    load: async () => {
      const { PlainAgent } = await import("../../agents/plain/index");
      return new PlainAgent();
    },
  },
  {
    id: "tella",
    label: "Tella feeds",
    doc: "docs/feeds-design.md",
    enableFlag: "ENABLE_TELLA_MODULE",
    env: [],
    // Reference feed module: self-gating. getFeed() stays null until the tella
    // MCP server is configured and connected, so an unconfigured module
    // contributes no webhooks and an empty route map.
    always: true,
    load: async () => {
      const { TellaAgent } = await import("../../agents/tella/index");
      return new TellaAgent();
    },
  },
  {
    id: "linear",
    label: "Linear",
    doc: "docs/setup/linear.md",
    enableFlag: "ENABLE_LINEAR_AGENT",
    env: [
      { name: "LINEAR_API_KEY", required: true, description: "API key for issue reads/writes" },
      { name: "LINEAR_WEBHOOK_SECRET", description: "verifies inbound webhook signatures" },
      { name: "LINEAR_CLIENT_ID", description: "OAuth app client id" },
      { name: "LINEAR_CLIENT_SECRET", description: "OAuth app client secret" },
    ],
    load: async () => {
      const { LinearAgent } = await import("../../agents/linear/index");
      return new LinearAgent();
    },
  },
  {
    id: "slack",
    label: "Slack",
    doc: "docs/setup/slack.md",
    enableFlag: "ENABLE_SLACK_AGENT",
    env: [
      { name: "SLACK_BOT_TOKEN", example: "xoxb-", required: true, description: "bot user token" },
      {
        name: "SLACK_SIGNING_SECRET",
        required: true,
        description: "verifies inbound event signatures",
      },
      { name: "ALLOWED_SLACK_USER_ID", description: "restricts admin tools to one user" },
      { name: "WORKTREE_HOOK_SECRET", description: "shared secret for worktree hooks" },
    ],
    load: async () => {
      const { SlackAgent } = await import("../../agents/slack/index");
      return new SlackAgent();
    },
  },
  {
    id: "stripe",
    label: "Stripe",
    doc: "docs/setup/integrations-misc.md#stripe",
    enableFlag: "ENABLE_STRIPE_AGENT",
    env: [
      {
        name: "STRIPE_WEBHOOK_SECRET",
        required: true,
        description: "verifies inbound webhook signatures",
      },
    ],
    // Without the signing secret every webhook fails verification, so there is
    // no point exposing the route at all.
    requires: () => Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    load: async () => {
      const { StripeAgent } = await import("../../agents/stripe/index");
      return new StripeAgent();
    },
  },
  {
    id: "grafana",
    label: "Grafana poller",
    doc: "docs/setup/integrations-misc.md#grafana-poller",
    enableFlag: "ENABLE_GRAFANA_POLLER",
    env: [
      { name: "GRAFANA_URL", required: true, description: "Grafana base URL" },
      {
        name: "GRAFANA_SERVICE_ACCOUNT_TOKEN",
        required: true,
        description: "service account token",
      },
      { name: "LOKI_DATASOURCE_UID", description: "Loki datasource to query" },
    ],
    load: async (ctx) => {
      const { GrafanaPollerAgent } = await import("../../agents/grafana-poller/index");
      return new GrafanaPollerAgent({ onSessionInvalidate: ctx.onSessionInvalidate });
    },
  },
  {
    id: "github",
    label: "GitHub",
    doc: "docs/setup/github.md",
    enableFlag: "ENABLE_GITHUB_AGENT",
    env: [
      {
        name: "GITHUB_API_TOKEN",
        required: true,
        description: "token for PR reads/writes via the gh CLI",
      },
      { name: "GITHUB_WEBHOOK_SECRET", description: "verifies inbound webhook signatures" },
      { name: "GITHUB_BOT_LOGIN", description: "login PRs are attributed to" },
      { name: "GITHUB_MENTION_HANDLES", description: "handles that trigger the PR agent" },
    ],
    load: async (ctx) => {
      const { GithubAgent } = await import("../../agents/github/index");
      return new GithubAgent({ onSessionInvalidate: ctx.onSessionInvalidate });
    },
  },
];

export function findIntegration(id: string): IntegrationSpec | undefined {
  return INTEGRATIONS.find((i) => i.id === id);
}
