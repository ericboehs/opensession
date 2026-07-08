# Backstage

Self-hosted agent-infrastructure server: a web UI plus Slack, Linear, Plain,
and GitHub agents, driving coding sessions through three engines (Claude Agent
SDK, Codex, OpenCode) in git worktrees or Docker sandboxes on your own box.

> **Note:** this project is being renamed to **OpenSession** — see
> [docs/rename-opensession-plan.md](docs/rename-opensession-plan.md).

<!-- TODO: screenshot — docs/screenshot.png (session view + sidebar) -->
*(screenshot placeholder)*

## Quickstart

```sh
git clone https://github.com/tellahq/backstage.git
cd backstage
bun install
bun run backstage.ts
```

Then read the real setup guide — secrets, accounts, integrations, systemd:

- **[docs/setup/](docs/setup/README.md)** — overview, requirements, trust model
- [docs/setup/install.md](docs/setup/install.md) — bare box → running service
- [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md) — isolated
  Docker/Daytona/E2B execution for sessions

Portability status: parts of the codebase still carry Tella-specific literals
(repo registry defaults, Slack channel IDs, Linear OAuth redirect). What is
config today vs. what still needs a code edit is tracked honestly in
[docs/portability-audit.md](docs/portability-audit.md) and called out per page
in the setup docs.

## License

TBD — not yet licensed for redistribution.
