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
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

Installs Bun, the OpenCode engine, and the Tailscale client if you do not
have them, clones the source to `~/.opensession/src`, puts an `opensession`
command on your `PATH`, and walks you through configuration. Takes under a
minute on a fresh box.

```sh
opensession start      # run it
opensession doctor     # check the install
opensession update     # pull, reinstall, restart
opensession --help     # everything else
```

Or run it straight from a checkout:

```sh
git clone https://github.com/tellahq/opensession.git
cd opensession && bun install
bun run setup                             # same wizard, without the installer
```

The installer accepts `--dir`, `--channel <ref>`, `--no-engine`,
`--no-tailscale`, `--no-modify-path`, `--yes` and `--uninstall`; `--help`
lists them all.

Then read the real setup guide — secrets, accounts, integrations, systemd:

- **[docs/setup/](docs/setup/README.md)** — overview, requirements, trust model
- [docs/setup/install.md](docs/setup/install.md) — bare box → running service
- [docs/setup/ec2.md](docs/setup/ec2.md) — provisioning a clean EC2 box
- **[docs/local-profile.md](docs/local-profile.md)** — minimal single-user setup on macOS
- [docs/setup/networking.md](docs/setup/networking.md) — Tailscale, a custom
  domain, and verifying you are not public
- [docs/clients.md](docs/clients.md) — web UI, PWA, desktop shell, native app,
  Chrome extension
- [docs/nodes.md](docs/nodes.md) — attaching another machine as an
  execution node (`opensession connect`)
- [docs/worktrees.md](docs/worktrees.md) — how sessions map to git worktrees,
  and where the disk goes
- [docs/extending.md](docs/extending.md) — adding tools, recipes, integrations
  and providers
- [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md) — isolated
  Docker/Daytona/E2B/Box/Modal/AWS Lambda MicroVM execution for sessions

> **No built-in authentication.** OpenSession trusts everyone who can reach the
> address it binds to. Keep it on Tailscale, a private network, or behind an SSH
> tunnel — never expose it publicly. See the
> [trust model](docs/setup/README.md#trust-model-read-this), and
> [networking.md](docs/setup/networking.md) for how to set that up.

Repositories, identity, branding, public URLs, integration enablement,
deployment policy, client endpoints, action seeds, and automation seeds are
instance configuration
([docs/instance-configuration.md](docs/instance-configuration.md)). The source
defaults to a local, single-repository OpenSession install.

## macOS app

The native OS¹ Electron shell lives in [`os1-mac/`](os1-mac/). It shares this
repository with the frontend so window-material and title-bar changes can be
developed and released together. See its README for local development,
signing, and release instructions. Run `bun app:dev` from the repository root
to launch the frontend proxy and desktop app together.

## License

[Apache License 2.0](LICENSE). Use it, fork it, run it commercially, build on
it — the only obligations are keeping the notice and not using the project's
trademarks to imply endorsement.

Contributions are accepted under the same license; see
[CONTRIBUTING.md](CONTRIBUTING.md). Security reports go through
[SECURITY.md](SECURITY.md).
