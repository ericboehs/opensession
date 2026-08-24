# A publishable package format, data only for now

## What is missing

Open Session has five extension points and no way to hand one to somebody
else. If I build a Loom feed today (an MCP server entry, a feed descriptor, a
weekly automation and a skill that teaches the agent our editing conventions),
the only way to give it to you is a paragraph of instructions: add this to
`mcp-config.json`, paste this into `~/.opensession-feeds.json`, drop this
directory under `.agents/skills/`, then seed this automation. Four stores, four
hand edits, no record of where any of it came from, and no way to take it back
out.

That is the whole gap. Every piece is already data, already validated, already
installable one at a time. What does not exist is a **unit**: something with a
name and a version that bundles the pieces, that a stranger can publish, that I
can install with one command and remove without archaeology.

`docs/plugins.md` describes a much larger thing and is still a design doc. This
proposal takes the small half of it, the half that needs no new architecture,
and ships it. It deliberately does not build the plugin runtime, and the last
section says why that is a decision rather than a delay.

## The shape

A package is **a git repository with a manifest at its root**. Nothing else.
No registry, no npm, no signing infrastructure, no build step.

```
opensession-loom/
  opensession-plugin.json
  skills/
    loom-editing/
      SKILL.md
  README.md
```

```json
{
  "name": "loom",
  "version": "1.0.0",
  "description": "Your Loom videos as a project, with a weekly digest.",
  "homepage": "https://github.com/acme/opensession-loom",
  "mcpServers": {
    "loom": {
      "type": "http",
      "url": "https://mcp.loom.example/mcp",
      "headers": { "Authorization": "${LOOM_TOKEN}" }
    }
  },
  "feeds": [
    {
      "id": "loom",
      "title": "Loom",
      "refKind": "loom",
      "mcpServers": ["loom"],
      "items": {
        "server": "loom",
        "tool": "list_videos",
        "path": "videos",
        "map": { "id": "id", "title": "name", "ts": "updatedAt" }
      }
    }
  ],
  "automations": [
    {
      "id": "loom-weekly",
      "label": "Weekly video digest",
      "description": "Summarises what the team recorded last week.",
      "automation": {
        "name": "Loom weekly digest",
        "prompt": "...",
        "schedule": "0 9 * * 1",
        "mode": "ask",
        "mcpServers": ["loom"]
      }
    }
  ],
  "skills": ["skills/loom-editing"]
}
```

Four kinds of content, all of them things the instance already knows how to
store:

| In the manifest | Installs into | Existing writer |
| --- | --- | --- |
| `mcpServers` | `mcp-config.json` | `packages/core/opensession-server/src/server/connections.ts` |
| `feeds` | `~/.opensession-feeds.json` | `packages/core/opensession-server/src/server/feeds-config.ts` |
| `automations` | `integrations.seeds.automations` in `config.json` | `scripts/lib/recipes.ts` |
| `skills` | `.agents/skills/<name>/` | a directory copy |

The manifest is an envelope, in the sense `docs/plugins.md` argues for: it
carries what a card and an install button need (name, description, version,
what it requires) and dispatches each piece to the mechanism that already
exists for it. Behaviour stays in the type-specific payload. A feed entry is a
`ConfigFeed` exactly as the feeds store already defines one, and it is
validated by that store's own validator at install time rather than by a second
schema that would drift from it.

The word "plugin" survives in the file name and the CLI verb because that is
what people type and search for. The noun everywhere else is **package**, and
today a package is data. If runtime code ever arrives it will be a new manifest
key in this same envelope, gated separately, and calling the data-only thing a
plugin now would make that distinction harder to draw later.

## Lifecycle

```
opensession plugins add <owner/repo | git-url | path>   clone, validate, review, install
opensession plugins                                     what is installed
opensession plugins update <name>                       fetch, re-plan, re-apply
opensession plugins remove <name>                       reverse every artifact
```

**Add** clones into `~/.opensession-plugins/<name>` at depth 1, reads the
manifest, validates it, computes a plan against what the instance already has,
prints the plan for review, and applies it. The clone is kept: it is what
`update` fetches into, and it is where the installed skills came from.

**Update** fetches the same source, re-plans, and applies the difference.
Artifacts the new manifest no longer declares are removed. A skill whose
content changed is reported as a changed hash rather than being swapped in
silently, because a `SKILL.md` is text that goes into a model's context and an
upstream edit to it is a code change in every sense that matters here.

**Remove** walks the recorded artifact list backwards and reverses each one.
This is the part that needs a ledger rather than inference: `~/.opensession-plugins.json`
records, per package, its source, the commit it was installed from, and the
exact names of every artifact it created (MCP server names, feed ids,
automation keys, skill directories, with hashes). Without that record, remove
has to guess from name prefixes, and guessing wrong deletes somebody's
hand-written automation.

Three traps that the ledger and the plan exist to avoid, the first two already
documented in `docs/plugins.md`:

- **Seed resurrection.** An automation from a package lives in the config seed
  list, and seeding is create-if-absent on every boot. Removing the package has
  to remove the seed, not just the store row, or it comes back on the next
  restart. The removal path reuses `removeRecipe`, which does exactly this, and
  leaves an already-created automation in place for the human to delete, which
  is the same conservative behaviour `opensession automations remove` has.
- **Install state is server-side.** The ledger is a file in the state dir, not
  localStorage, so what is installed is the same fact for the web UI, the
  native app and the next boot.
- **A package may rename itself.** The manifest name is the ledger key, so an
  entry has to be found by where it came from as well: matching only the new
  name turns an update into a first install, which either collides with the
  artifacts the package itself installed or writes a second entry and strands
  the first with no name anyone can remove it by. The lookup is name, then
  origin, and a rename migrates the entry and says so in the review.

Installation is per-instance. Scoping at the point of use is the pattern three
times over already (feeds scope `mcpServers`, automations carry allowlists,
servers carry `allowedUsers`), and per-project installation would fragment the
trust decision into one review per project.

## Credentials are named references, never values

A package must not contain a secret, and the format enforces it rather than
asking nicely. Every value in an MCP server's `env` and `headers` blocks has to
be a bare `${NAME}` reference:

```json
"headers": { "Authorization": "${LOOM_TOKEN}" }
```

Anything else fails validation, and so does a server URL carrying a query
string or userinfo, because that is where a token hides when the headers are
clean. The reference resolves the way every other MCP server's credentials
resolve: the operator puts `LOOM_TOKEN` in their env file, and the connection
card reports `needs-env` until they do.

This is worth stating as a property rather than a lint: **a package repository
is publishable by construction.** There is nowhere in the manifest to put a
credential, so the usual accident (a working config committed to a public repo)
cannot happen through this path.

## Scoping is the installer's decision, not the package's

`allowedUsers` on an MCP server is the instance's own control over who gets a
tool. A manifest that could set it would be a package deciding who inside my
company can reach the server it just mounted, which is exactly backwards, so a
manifest carrying `allowedUsers` is rejected.

The operator supplies it instead:

```
opensession plugins add acme/opensession-loom --users michiel,kent
```

That list is applied to every server the package installs and recorded in the
ledger, so an update preserves it rather than quietly widening access back to
everyone. Automation runs pass no user at all, so a scoped server is invisible
to them, which is the existing fail-closed behaviour and the reason this
control is worth wiring here rather than leaving to a later settings pass.

Automations from a package always install **disabled**, and a manifest may not
set `enabled: true` or `selfImprove`. A package can propose a scheduled job; it
cannot start one, and it certainly cannot ship one that rewrites its own
prompt.

## Trust

Installing a package mounts an MCP server and injects text into agent context.
Both of those are consequential on an instance that holds Slack, GitHub and
Stripe credentials and runs autonomous agents over untrusted ticket text. The
honest inventory of what a malicious package can do, even with no code
execution anywhere in this design:

- **Mount a hostile MCP server.** The server's tools appear to sessions that
  are in scope for it. Tool descriptions are model-facing text, so a hostile
  server can attempt to steer a run, and a tool the model calls can exfiltrate
  whatever it was handed. This is the largest risk and it is not new: it is
  identical to the risk of adding any MCP server by hand, which is why the
  review step prints the server's transport and target verbatim.
- **Inject a prompt through a skill.** A `SKILL.md` is loaded into context when
  the agent judges it relevant. A malicious one is a prompt injection with a
  standing invitation. Hence hash-pinning and diffs on update.
- **Seed an automation.** The prompt is model-facing text on a trigger. It
  installs disabled, so the worst case is that somebody enables it without
  reading it, which is the same failure mode bundled recipes already have.
- **Point a feed at somebody else's data.** A feed descriptor names a server
  and a tool. It cannot reach further than that server can.

What it cannot do, in this design: run code at install time, run code in the
server process, read the session token, call the Open Session API, reach
another package's credentials, or read the env file. None of those are
prevented by a sandbox; they are prevented by there being no mechanism.

The gates:

1. **Validation before anything is written.** Names are slugs, secrets are
   references, paths cannot escape the checkout, `allowedUsers` and
   `selfImprove` are refused, automations are forced disabled.
2. **A printed plan.** Every artifact the install would create, with the MCP
   transport and target, the env var names it wants, the automation prompts,
   and each skill file with its hash. This is the review, and it is the whole
   point of the confirmation being interactive by default.
3. **Explicit confirmation.** `--yes` exists for scripted installs and is the
   line an agent has to cross deliberately. A run that types `--yes` on a
   package a human has not looked at has made a decision, and it is legible
   afterwards because the ledger records the source and commit.
4. **No overwrite, ever.** If any artifact name collides with something this
   package does not already own, the install refuses as a whole rather than
   merging into somebody else's server or feed. A half-installed package is
   worse than a failed one.
5. **Clone hardening.** `--depth 1`, no submodules, `protocol.ext.allow=never`
   (the `ext::` transport is remote command execution wearing a URL costume),
   hooks path neutered, and only `https`, `ssh` and local paths accepted.

What is deliberately not built: signing, a trusted publisher list, and any
notion of a package being "verified". Those are meaningful once there is a
registry with an operator behind it, and performative before that. Reviewing
the plan, and the fact that the source is a git URL you can go and read, is the
trust model, stated plainly instead of dressed up.

## Discovery

The convention is a GitHub topic: **`opensession-plugin`**. A repository with
that topic and a valid manifest is discoverable by anyone, with no gatekeeper
and no submission process, and `https://github.com/topics/opensession-plugin`
is the catalog until there is a reason for a better one.

This is the deliberate copy of the thing that made DeepSeek Harness's ecosystem
appear in two days: the ability to publish without asking. A curated in-repo
list would be safer and would also mean every third party has to open a pull
request against us before their work is findable, which is the difference
between an ecosystem and a queue.

Installed packages appear in the existing Library catalog (`packages/core/opensession-server/src/server/library.ts`)
as one entry each, rather than in a parallel list. The library is already the
front door for "what can this instance be extended with", and a package that
did not show up there would be the second catalog the module's own doc warns
against.

## Explicitly out of scope: runtime-loaded code

No package ships JavaScript that this server or this browser executes. Not an
ESM bundle, not a UI surface, not a server hook, not a `postinstall`. The
installer copies data into stores that already existed and does not evaluate
anything it downloaded.

Four reasons, in the order they actually decide it:

**The trust decision cannot be delegated to a catalog.** A runtime-loaded
plugin sharing the host's React is same-origin code: it can read the session
token, call every API as the signed-in person, and reach every other plugin's
data. There is no gate that makes one-click installation of that safe, so it
would need a separate, louder, non-skippable trust prompt. Building the code
tier now would mean building two trust models at once and getting the easy one
wrong in the shadow of the hard one.

**The contract is not ready to freeze.** The first external plugin freezes
whatever interfaces exist the day it ships, including the bad ones. Today's
"panel registry" is two hardcoded ternaries checking for `component ===
"slack-channel"`. Publishing a UI contract on top of that would be publishing
an accident.

**A code plugin contributes nothing to four of the five clients.** The native
app, the TUI, the Chrome extension and the widgets do not run web bundles. A
data package works everywhere by construction, because a feed, an automation
and an MCP server are server-side facts. That asymmetry is worth paying
attention to before making the web the only surface a third party can extend.

**The demand is smaller than it looks.** Of the four things people actually
want to hand each other today (a feed, some automations, a skill, an MCP
wiring), none needs code. The generic schema-derived panel described in
`docs/plugins.md` covers the write path for the fifth. If runtime code arrives
later it arrives as an additional manifest key in this same envelope, gated on
its own explicit consent, and everything above keeps working unchanged.

## What ships with this proposal

The minimal path, and nothing beyond it:

- `packages/core/opensession-server/src/server/plugins.ts`: the manifest type, its validator, and the ledger.
- `scripts/lib/plugins.ts`: fetch, plan, apply, remove, and the review summary.
- `opensession plugins add|update|remove` plus the bare listing verb.
- One Library entry per installed package.
- Tests for validation and for install/remove idempotency.

Deliberately not included: a web install button (the CLI is the install
surface; the library card links to the source), a package's own settings UI,
version constraints between packages, and dependencies between packages. Each
of those is easy to add later and none of them is needed to hand somebody a
Loom feed.
