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
git clone <your-opensession-repository-url> opensession
cd opensession
bun install
bun run opensession.ts
```

Then read the real setup guide — secrets, accounts, integrations, systemd:

- **[docs/local-profile.md](docs/local-profile.md)** — minimal single-user setup on macOS
- **[docs/setup/](docs/setup/README.md)** — overview, requirements, trust model
- [docs/setup/install.md](docs/setup/install.md) — bare box → running service
- [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md) — isolated
  Docker/Daytona/E2B/Box/Modal/AWS Lambda MicroVM execution for sessions

Repositories, identity, branding, public URLs, integration enablement,
deployment policy, client endpoints, action seeds, and automation seeds are
instance configuration. The source defaults to a local, single-repository
OpenSession install.

## macOS app

The native OS¹ Electron shell lives in [`os1-mac/`](os1-mac/). It shares this
repository with the frontend so window-material and title-bar changes can be
developed and released together. See its README for local development,
signing, and release instructions. Run `bun app:dev` from the repository root
to launch the frontend proxy and desktop app together.

## License

TBD — not yet licensed for redistribution.
