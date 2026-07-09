# OpenSession

Self-hosted agent-infrastructure server: a web UI plus Slack, Linear, Plain,
and GitHub agents, driving coding sessions through the OpenCode engine
(any model provider) in git worktrees or Docker sandboxes on your own box.

> Not related to opencode's `opensession` npm session viewer or to
> ColeMurray/background-agents ("Open-Inspect").

<!-- TODO: screenshot — docs/screenshot.png (session view + sidebar) -->
*(screenshot placeholder)*

## Quickstart

```sh
git clone https://github.com/tellahq/backstage.git tella-backstage
cd tella-backstage
bun install
bun run opensession.ts
```

Then read the real setup guide — secrets, accounts, integrations, systemd:

- **[docs/setup/](docs/setup/README.md)** — overview, requirements, trust model
- [docs/setup/install.md](docs/setup/install.md) — bare box → running service
- [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md) — isolated
  Docker/Daytona/E2B execution for sessions

Portability status: parts of the codebase still carry Tella-specific literals
(repo registry defaults, Slack channel IDs, Linear OAuth redirect). What is
config today vs. what still needs a code edit is called out per page in the
setup docs.

## License

TBD — not yet licensed for redistribution.
