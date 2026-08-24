# Extending Open Session

Five extension points, in rough order of how often you will reach for them.
Adding capability should mean touching one of these — if you find yourself
editing `opensession.ts`, that is usually a sign the thing you want is missing an
extension point rather than that you need to edit the entry file.

Before extending, read what is already there. Two catalogs under
`docs/generated/` are produced from the code itself by
`bun scripts/gen-catalogs.ts`, and a test fails when they go stale:

- [generated/mcp-tools.md](generated/mcp-tools.md) — every tool the built-in
  `opensession-*` servers expose, with the run classes that can call it.
- [generated/engines.md](generated/engines.md) — the engine adapters, what
  turns each one on, and which engine a model routes to.

## 1. MCP servers — give sessions new tools

The lowest-effort way to add capability, and the one that requires no Open Session
code at all. Any [Model Context Protocol](https://modelcontextprotocol.io)
server becomes tools your sessions can call.

Add it in the Connections UI, or in `mcp-config.json`:

```json
{
  "mcpServers": {
    "mytool": {
      "command": "npx",
      "args": ["-y", "@example/mcp-server"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

Two things worth knowing:

- **`allowedUsers`** scopes a server to specific people. With it set, runs by
  anyone else never see those tools. Automation runs pass no user at all, so a
  restricted server is invisible to them — deliberately fail-closed, so untrusted
  ticket text can never reach a sensitive tool.
- Servers carry **their own credentials**. Agent subprocesses get a minimal
  environment without your tokens; an MCP server is given what it needs and
  nothing else.

Config is read per run, so adding a server does not need a restart. Changing the
*enforcement* code does.

Open Session's own tools are different: the `opensession-*` servers run
in-process and are handed to a run by code, not config —
`packages/core/opensession-server/src/server/interactive-mcp.ts` for interactive runs,
`packages/core/opensession-server/src/server/automations.ts` for unattended ones. Adding one means adding an
entry to `packages/core/opensession-server/src/server/mcp-catalog.ts` as well, which is what keeps
[generated/mcp-tools.md](generated/mcp-tools.md) honest; the test suite fails
until you do.

## 2. Automation recipes — package a repeatable job

A prompt plus a trigger. Drop a JSON file in `recipes/automations/` and it
becomes installable with `opensession automations add <id>`.

See [recipes/README.md](../recipes/README.md) for the schema, the house style for
writing the prompt, and — more importantly — the line between what belongs in
the repository and what belongs in your instance config. Short version: if a
stranger could run it on their own repository and get a sensible result, it can
ship; if it needs a paragraph of your company's context, it is instance config.

Scheduled automations can also declare `inputs`: independently collected source
windows that are flattened by a tool-less one-shot model before the main run.
The built-in providers are Slack channels and structured report history; their
small per-input cursor files are checkpoints, not agent memory, and never retain
raw source data. `outputs` currently supports durable Reports plus an optional
server-side Slack notification derived from a report's structured urgency and
confidence. Keep Slack disabled while evaluating a new analysis routine: the
main model does not need the Slack MCP merely because Slack is an input or a
future output.

## 3. Integrations — react to an external system

An integration is an agent module that owns webhook routes and a background
loop: Slack, Linear, Plain, GitHub, Stripe all work this way.

Append an entry to `packages/core/opensession-server/src/server/integrations/registry.ts`:

```ts
{
  id: "mytool",
  label: "My Tool",
  doc: "docs/setup/mytool.md",
  enableFlag: "ENABLE_MYTOOL_AGENT",
  env: [
    { name: "MYTOOL_API_KEY", required: true, description: "API key" },
    { name: "MYTOOL_WEBHOOK_SECRET", description: "verifies inbound signatures" },
  ],
  load: async (ctx) => {
    const { MyToolAgent } = await import("../../agents/mytool/index");
    return new MyToolAgent();
  },
}
```

That single entry is enough for onboarding to offer it, `opensession
integrations enable mytool` to work, `opensession doctor` to report a missing
credential by name, and `loadAgents()` to construct it. **Nothing in
`opensession.ts` changes.**

The agent itself implements `AgentModule` (`packages/core/opensession-server/src/agents/types.ts`): a route map
for webhooks, and a `start()` for any polling. Model your first one on
`packages/core/opensession-server/src/agents/linear/` — it is the smallest complete example.

Rules the registry enforces, and why:

- **Array order is boot order**, because agents register webhook routes in
  sequence. Append; do not reshuffle.
- A module that throws on import is **logged and skipped**, never fatal. One
  broken integration must not take the server down.
- `requires` is an extra runtime gate — Stripe uses it to stay unloaded without a
  signing secret, since every webhook would fail verification anyway.
- `always: true` means "load regardless of config and self-gate internally".

This is a boot path, so it needs a real restart.

## 4. Sandbox providers — run sessions somewhere else

`packages/core/opensession-server/src/server/sandbox/` holds one file per provider — Docker (and the local host
runner) at the root, with Daytona, E2B, Modal, Box and the MicroVM / Lambda
MicroVM adapters under `adapters/`. Implement the `SandboxProvider` contract —
create, exec, destroy, plus the dial-back plumbing for remote compute — and
register it.

Read [self-hosting-sandboxes.md](self-hosting-sandboxes.md) first, particularly
the path-parity section: the sandbox's filesystem layout must match the host's,
and "tidying" that is a well-signposted way to break every provider at once.

Note the certification status in that document. Several adapters are implemented
but not live-certified; adding a sixth is easier than making one trustworthy.

## 5. Skills — teach agents a workflow

`.agents/skills/<name>/SKILL.md` is markdown an agent loads when relevant. No
code, no registration. This is the cheapest way to encode "how we do X here" —
a review checklist, a deployment runbook, a design vocabulary.

Generic skills shipped by Open Session live in this repository under
`.agents/skills/`, and every run loads that directory whatever repo the
session is working on. A session's own checkout adds to the set with its
`.claude/skills/` or `.agents/skills/`, and a name the checkout defines beats
the shipped one. Product-specific workflows belong in that product's
repository instead.

The list of directories is `src/server/skill-paths.ts`, read by both the runner
and the composer's "/" menu so the menu cannot offer a skill a turn would not
load. Start a message with a skill's name to run it: `/bro`, or `/skill:bro`
if you prefer pi's own spelling. A skill with `disable-model-invocation: true`
stays out of the system prompt and only runs when someone asks for it by name.

If you catch yourself pasting the same three paragraphs into prompts, that is a
skill.

## Handing one of these to somebody else

Any of the above that is data (an MCP server entry, a feed descriptor, an
automation recipe, a skill) can be bundled into a **package**: a git
repository with an `opensession-plugin.json` manifest, installed with
`opensession plugins add <owner/repo>`. It is the unit that makes an extension
publishable, and it deliberately carries no runtime code. See
[packages.md](packages.md).

## What not to extend

**The runner.** `agent-runner.ts`, `pi-runner.ts` and `host-client.ts` are
runner internals with a lot of load-bearing behaviour around restarts,
reattachment and account rotation. Changes there need a real restart and are easy
to get subtly wrong — a mistake usually shows up as sessions that look fine and
silently never progress.

**The entry file.** `opensession.ts` is deliberately thin. If your change needs
to go there, check whether the right move is a new extension point instead.

## Security when you extend

Everything above runs against untrusted input at some point — a customer ticket,
a pull-request diff, an issue body. The invariant is that constraints are
enforced at the tool and environment layer, never in a prompt:

- automation runs get a minimal environment with none of your tokens
- each automation carries an MCP-server allowlist
- customer-facing and identity-mutating tools are hard-denied for unattended runs
- money-moving tools are stripped from the model's tool list entirely

If your extension needs a credential, give it to the MCP server rather than the
run. If it needs a dangerous capability, gate it on the run being interactive.
And treat anything your extension reads — a ticket, a diff, a page — as data,
never as instructions.
