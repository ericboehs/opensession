# Contributing

Thanks for looking. OpenSession is a self-hosted agent-infrastructure server —
one Bun process serving a web UI, a set of integrations, and the machinery that
runs agent sessions in git worktrees.

## Getting set up

```sh
git clone https://github.com/tellahq/opensession.git
cd opensession
bun install
bun run setup          # writes ~/.opensession/config.json and ~/.opensession.env
bun run opensession.ts # or: opensession start --foreground
```

You need [Bun](https://bun.sh) and `git`. Everything else is optional until you
touch the feature that needs it — `gh` for pull-request work, the
[OpenCode](https://opencode.ai) binary to actually execute agent turns, Docker
only if you are working on sandboxes.

The UI comes up at `http://127.0.0.1:3850`. There is no login by default; see
[the trust model](docs/setup/README.md#trust-model-read-this) before binding it
anywhere but loopback.

## Before you open a pull request

```sh
bun run typecheck      # must be clean
bun test               # must be green
```

CI runs both on every PR, plus an end-to-end install on Linux and macOS. If you
touched `install.sh`, the CLI or the service definitions, that installer job is
the one that matters — it catches the things unit tests cannot, like a `PATH`
that works interactively and not from a script.

## Things that will surprise you

**Backend changes need a real restart.** The in-process watcher rebuilds the
frontend live, but nothing reloads the server. `opensession restart` (or
`systemctl restart opensession`) after a backend edit — and once, not after
every save.

**`bun --hot` is deliberately not used in production.** On Bun 1.3.14 a failed
reload can permanently stop timer delivery while HTTP keeps serving, which
looks like "sessions are running but never progress".

**Integrations are declared, not hand-wired.** Adding one means appending an
entry to `src/server/integrations/registry.ts` — config key, env flag,
credentials, constructor. `loadAgents()` is a loop over that array; you should
not need to touch `opensession.ts`. The array order is boot order, because
agents register webhook routes in sequence.

**Automations are per-instance data, not source.** Anything specific to one
company's product, customers or people belongs in that instance's config. The
repository ships only generic recipes — see
[recipes/README.md](recipes/README.md) for where the line is.

## Code style

Match the file you are editing. The codebase is fairly consistent about this,
and consistency beats any individual preference.

Comments should explain *why*, particularly when the code looks odd. A lot of
the stranger-looking decisions here encode a specific incident — `KillMode=mixed`
in the systemd unit, the `IPAddressDeny` line, the deny-before-allow ordering in
permission maps. If you find one of those and it has no comment, adding the
explanation is a genuinely useful contribution.

Prefer deleting to adding. If a change makes something simpler, say so in the
PR; that is not a small thing.

## Security

Agent runs process untrusted text — customer tickets, pull-request diffs, issue
bodies. The rule is that constraints are enforced at the tool and environment
layer, never in a prompt:

- automation runs get a minimal environment with none of your tokens
- each automation carries an MCP-server allowlist
- customer-facing and identity-mutating tools are hard-denied for unattended runs
- money-moving tools are stripped from the model's tool list entirely

If a change touches any of that, say so explicitly in the PR description. If you
find a way around it, report it privately — see [SECURITY.md](SECURITY.md), which
also sets out what counts as a vulnerability here and what is working as
designed.

## Reporting bugs

Include what you ran, what happened, and `opensession doctor` output. If it is
an install problem, the full installer output — it prints every step it took.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project.
