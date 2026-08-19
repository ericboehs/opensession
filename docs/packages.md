# Packages

A package is how you hand somebody an extension instead of a paragraph of
instructions. It is **a git repository with `opensession-plugin.json` at its
root**, bundling any of four things this instance already knows how to store:

| In the manifest | Installs into |
| --- | --- |
| `mcpServers` | `mcp-config.json` |
| `feeds` | `~/.opensession-feeds.json` |
| `automations` | the config seed list, disabled |
| `skills` | `.agents/skills/<name>/` |

No registry, no npm, no build step, and **no runtime code**: nothing in a
package is ever executed by the server or the browser. The reasoning is in
[adrs/publishable-packages.md](../adrs/publishable-packages.md).

```sh
opensession plugins                        # what is installed
opensession plugins add acme/my-package    # review, then install
opensession plugins add acme/my-package --users michiel,kent
opensession plugins update my-package
opensession plugins remove my-package
```

`add` clones the repository, validates the manifest, prints every artifact it
would write, and asks. Reading that plan is the trust model: installing mounts
an MCP server whose tools your sessions can call, and adds text your agents
read. `--yes` skips the question for scripted installs.

## The manifest

```json
{
  "name": "loom",
  "version": "1.0.0",
  "description": "Your Loom videos as a project, with a weekly digest.",
  "homepage": "https://github.com/acme/opensession-loom",
  "requires": [],
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
      "id": "weekly",
      "label": "Weekly video digest",
      "description": "Summarises what the team recorded last week.",
      "automation": {
        "name": "Loom weekly digest",
        "prompt": "List the videos recorded in the last seven days...",
        "schedule": "0 9 * * 1",
        "mode": "ask",
        "mcpServers": ["loom"]
      }
    }
  ],
  "skills": ["skills/loom-editing"]
}
```

A feed entry is a `ConfigFeed` exactly as the feeds store defines one
(`packages/core/opensession-server/src/server/feeds-config.ts`); an automation entry is a recipe as
`recipes/README.md` describes one. The manifest is an envelope around them
rather than a second schema.

## Rules the format enforces

These are validated before anything is written, and a failure names the field:

- **No secrets.** Every value in a server's `env` and `headers` must be a bare
  `${NAME}` reference, and a server URL may carry neither a query string nor
  userinfo. A package repository is publishable by construction: there is
  nowhere in the format to put a credential. The operator supplies `LOOM_TOKEN`
  in their env file, and the connection card says `needs-env` until they do.
- **No self-scoping.** A manifest may not set `allowedUsers`. Who inside your
  company reaches a tool is your call, so it comes from `--users` at install
  time and is remembered across updates.
- **No self-starting.** Automations install disabled, and a manifest may not
  set `enabled` or `selfImprove`. A package proposes a job; you start it.
- **No overwriting.** If any name a package wants is already taken by something
  it does not already own, the whole install refuses. Nothing is half-applied.
- **No escaping the package.** Skill paths are relative and cannot contain
  `..`.

## What installing records

`~/.opensession-plugins.json` holds, per package, the source, the commit it was
installed from, and the exact name of every artifact it created, with a sha256
for each skill. That ledger is what makes `remove` exact: it reverses the names
it recorded rather than guessing from a prefix, so it can never delete an
automation you wrote yourself. The checkout stays under
`~/.opensession-plugins/<name>/` and is what `update` fetches into.

Two things `remove` deliberately does not do: it leaves an automation the
server has already created from the seed in place (delete it in the UI, as with
`opensession automations remove`), and it does not touch data a package's
server holds elsewhere.

## Publishing one

Push the repository and give it the GitHub topic **`opensession-plugin`**.
That is the whole distribution story:
[github.com/topics/opensession-plugin](https://github.com/topics/opensession-plugin)
is the catalog, there is no submission process, and nobody has to approve you.

A good package README says what the MCP server is, which credential it needs
and where to get it, and what the automations would do on a schedule. Someone
is going to read that before typing `y`.

Installed packages show up in Settings → Library beside the rest of the
catalog, one card each.
