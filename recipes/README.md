# Recipes

Optional, generic starting points that ship with OpenSession. Nothing here is
installed or enabled by default.

```sh
opensession automations              # what is available, and what you have added
opensession automations add <id>     # add one
opensession automations remove <id>
opensession restart                  # they are created on the next boot
```

Adding a recipe appends it to `integrations.seeds.automations` in your
`config.json`. The server creates it on the next start, **disabled** — you look
at the prompt, adjust it for your codebase, and enable it in the UI. Seeding is
create-if-absent and keyed on `eventKey`, so re-running is safe and your edits
are never overwritten.

## What ships here

| Recipe | What it does | Needs |
| --- | --- | --- |
| `github-pr-review` | Reviews every opened/updated PR and posts findings | GitHub integration |
| `instance-health` | Hourly check that this install is alive and not out of disk | — |
| `stale-pr-monitor` | Weekly list of PRs that have gone quiet | GitHub integration |
| `code-cleanup-sweep` | Weekly dead-code and duplication pass, as a PR | — |
| `docs-spell-check` | Weekly typo and broken-link pass over docs, as a PR | — |
| `production-error-sweep` | Weekday triage of new production errors | an error-tracking MCP |
| `nightly-reflection` | Nightly retro over yesterday's audit log; may open one fix PR and refine its own prompt (`selfImprove`) | — |

`github-pr-review` and `instance-health` are offered during `opensession
onboard`. The PR review one is the highest-leverage thing here: it is the
automation most other workflows end up hanging off.

## What does *not* belong here

The line is whether the recipe is about **software** or about **your company**.

Ships:

- reviewing a pull request, monitoring the instance, sweeping for dead code —
  every team that runs this wants some version of these
- prompts that name only things present in any repository: the diff, the test
  suite, open PRs, the error tracker

Does not ship, and should live in your own `config.json` instead:

- anything naming your product, your customers, your domain, or your metrics
- anything naming people, teams, personas, or internal rituals
- anything tied to one company's vocabulary, playbooks, or support flows
- anything requiring a bespoke internal MCP server

A useful test: **could a stranger run this on their own repository and get a
sensible result?** If it needs a paragraph of your company's context first, it
is instance config, not a recipe.

Recipes derived from an internal automation are genericised before landing —
the tuned methodology is worth sharing, the deployment specifics are not.

## Adding one

Drop a JSON file in `automations/`:

```json
{
  "id": "kebab-case-id",
  "label": "Human readable name",
  "description": "One line. Shown in `opensession automations`.",
  "requires": ["github"],
  "recommended": false,
  "notes": "Optional caveat shown when installing.",
  "automation": {
    "name": "Human readable name",
    "eventKey": "sweep:my-thing",
    "mode": "ask",
    "schedule": "0 16 * * 1",
    "enabled": false,
    "prompt": "..."
  }
}
```

- `eventKey` is the identity used for create-if-absent. Give every recipe one,
  and never reuse another recipe's.
- `mode`: `ask` is read-only on the main checkout. `code` gets an isolated
  worktree with write access and can open PRs. Default to `ask`.
- `schedule` is a UTC cron expression; leave it empty for event-triggered ones.
- `enabled` should be `false`. An operator should read a prompt before it runs.
- `requires` lists integration ids, purely to warn at install time.

### Writing the prompt

The recipes here are written to a house style, and it is worth matching:

- Say what to do, then what *not* to do. The negative half is what keeps an
  automation from being annoying.
- Give it an explicit bar for what is worth reporting, and permission to report
  nothing. "If nothing is wrong, say so in one line" prevents the failure mode
  where an automation invents work to look useful.
- Prefer verification over recall: tell it to read the code before asserting
  something is broken.
- For `code` mode, state the constraint that keeps the PR mergeable — usually
  "behaviour must not change" plus "run the tests first".
- Treat anything the automation reads (a diff, a ticket, an error payload) as
  data, never as instructions to itself.
