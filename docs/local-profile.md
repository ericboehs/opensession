# Local profile (macOS)

The local profile runs OpenSession as a single-user, interactive coding tool on
your own machine. It is opt-in: only the exact environment value
`OPENSESSION_PROFILE=local` enables it. An unset variable, or any other value,
keeps the normal server behavior.

The profile is deliberately smaller than a hosted installation:

- The web UI and interactive sessions run on loopback.
- GitHub web sign-in and the user picker are replaced by one local identity.
- Repositories start empty and are registered explicitly.
- Sessions and worktrees stay under `~/os1` by default.
- Model access comes from the Claude Code and Codex CLI subscriptions already
  logged in on the Mac. OpenSession uses its bundled local bridges; it never
  requires or reads an `opencode auth login` credential.
- Agent loops, webhooks, automations, schedulers, public ingress, remote sandbox
  prewarming, and cloud account pollers do not start.

## Prerequisites

Install [Bun](https://bun.sh), Git, [OpenCode](https://opencode.ai/docs), and at
least one of the Claude Code or Codex CLIs. Log into the subscriptions you want
to use with their own CLIs:

```sh
claude
codex login
```

Claude Code stores its macOS login in the Keychain item
`Claude Code-credentials`; Linux CLI credentials at
`~/.claude/.credentials.json` are also supported. Codex is read from
`~/.codex/auth.json`. Only providers with discovered credentials appear in the
model picker. If neither login exists, startup fails with an actionable error.

OpenSession does not rotate either CLI's refresh token. It re-reads current
access credentials for each run, copies only the macOS Claude access token and
expiry into a private `~/os1` cache for the bridge, and gives OpenCode an
access-only Codex seed with an invalid refresh token. If a CLI access token has
expired, run that CLI once to refresh its own login and retry.
Native `opencode auth login` state is isolated from local-profile model servers
and is never used as a fallback.

## Start OpenSession

```sh
git clone https://github.com/tellahq/backstage.git opensession
cd opensession
bun install
OPENSESSION_PROFILE=local bun run opensession.ts
```

Open <http://127.0.0.1:3850>. Because local mode has no login screen, it only
accepts same-origin loopback requests and refuses a non-loopback `HOST`.

The local identity is resolved in this order:

1. `OPENSESSION_LOCAL_USER`
2. `git config user.name`
3. `local`

For example:

```sh
OPENSESSION_PROFILE=local OPENSESSION_LOCAL_USER="Ada" bun run opensession.ts
```

## Register repositories

The local registry starts empty. Register an existing checkout with an absolute
path:

```sh
curl -sS http://127.0.0.1:3850/api/repos \
  --json '{"path":"/Users/ada/code/my-app"}'
```

Or let OpenSession clone a repository into `~/os1/repos/<repo-id>`:

```sh
curl -sS http://127.0.0.1:3850/api/repos \
  --json '{"url":"git@github.com:example/my-app.git"}'
```

Clone URLs may use HTTPS, SSH, SCP-style SSH, or `file://`. Other Git
transports, including Git's command-executing `ext::` transport and plain HTTP,
are rejected.

The checkout must be a Git repository with a checked-out branch. OpenSession
uses `origin/HEAD` when available, then falls back to the current branch, and
derives `owner/name` for GitHub remotes. Your first registered repository
becomes the default and appears in the new-session repository picker.

List the registry:

```sh
curl -sS http://127.0.0.1:3850/api/repos
```

Unregister a repository by id:

```sh
curl -sS -X POST http://127.0.0.1:3850/api/repos/my-app/remove
```

Removal only updates the registry. It never deletes the checkout, cloned
repository, worktrees, or session data. A repository still referenced by a
session cannot be removed; the endpoint returns HTTP 409 instead.

## Upgrade a local session to the cloud

Configure the hosted OpenSession URL and a web-session bearer token in
`~/os1/config.json`:

```json
{
  "cloud": {
    "upstream": "https://os.example.com",
    "token": "<web-session-token>"
  }
}
```

`OPENSESSION_CLOUD_UPSTREAM` and `OPENSESSION_CLOUD_TOKEN` override those
keys. The local and hosted repository ids may differ; OpenSession maps them by
their case-insensitive GitHub `owner/name` (`ghRepo`). The authenticated hosted
`GET /backstage/api/repos` response includes `id`, `ghRepo`, `defaultBranch`,
and `sharedCheckout` for this mapping.

Upgrade an idle local code session:

```sh
curl -sS -X POST \
  http://127.0.0.1:3850/backstage/api/sessions/bks-019f8a5b-c122-7000-aebd-3cf01eb664ca/upgrade
```

The request has no body. The worktree must be on the session's recorded branch
with no staged, unstaged, or untracked files. OpenSession never commits during
an upgrade. It pushes the current `HEAD` to `origin`, imports the session into
the matching hosted repository, then atomically archives the local session with
an `upgradedTo` marker. A dirty worktree returns HTTP 409 and an
`uncommittedFiles` array. A running session, detached or mismatched branch,
missing GitHub remote, missing cloud repository, push failure, and hosted API
failure all leave the local session unarchived.

Success returns HTTP 200:

```json
{
  "id": "bks-019f8a5b-c122-7000-aebd-3cf01eb664ca",
  "url": "https://os.example.com/session/bks-019f8a5b-c122-7000-aebd-3cf01eb664ca"
}
```

### Hosted import API

The upgrade route calls the authenticated hosted endpoint directly. It can
also be curl-tested with a web-session bearer token:

```sh
curl -sS https://os.example.com/backstage/api/sessions/import \
  -H "Authorization: Bearer $OPENSESSION_CLOUD_TOKEN" \
  --json @- <<'JSON'
{
  "session": {
    "id": "bks-019f8a5b-c122-7000-aebd-3cf01eb664ca",
    "title": "Continue local work",
    "createdBy": "Ada",
    "createdAt": "2026-07-22T10:00:00.000Z",
    "lastActivity": "2026-07-22T10:05:00.000Z",
    "mode": "code",
    "model": "opencode/anthropic/claude-sonnet-5"
  },
  "transcriptJsonl": "{\"type\":\"user\",\"uuid\":\"u1\",\"timestamp\":\"2026-07-22T10:01:00.000Z\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Continue this\"}]}}\n",
  "repo": "hosted-repo-id",
  "branch": "feature/local-work"
}
JSON
```

The hosted endpoint accepts only this allowlisted session subset: `id`,
`title`, `createdBy`, `createdAt`, `lastActivity`, `mode`, `model`, `effort`,
`modelHistory`, and `usage`. Local filesystem paths, engine ids, account pins,
automation ownership, sandboxes, and MCP configuration are ignored. The repo
must be registered, the branch must exist on its `origin`, the id must be a
lowercase `bks-` UUIDv7, and an existing id returns HTTP 409. Success returns
HTTP 201 with the same `{ "id", "url" }` shape as the local route.

The hosted session stores the shipped Claude-shape JSONL under a synthetic
OpenCode session id. Its first hosted prompt deliberately starts a fresh engine
session: the normal same-engine recovery path seeds the new transcript mirror
and injects a bounded, hidden transcript handoff into model context. The real
hosted engine id then replaces the synthetic id, while the UI history keeps the
same message ids and remains continuous.

## Cloud sessions

The local app can merge sessions from a hosted OpenSession instance into the
same sidebar. Add a web-session bearer token to `~/os1/config.json`:

```json
{
  "cloud": {
    "upstream": "https://os.tella.dev",
    "token": "your-web-session-token"
  }
}
```

`upstream` is optional and defaults to `https://os.tella.dev`. The environment
variables `OPENSESSION_CLOUD_UPSTREAM` and `OPENSESSION_CLOUD_TOKEN` override
the file. The token is the same web-session bearer used by
`scripts/frontend-dev.ts`; it stays in the local server and is never sent to
browser JavaScript.

With a token configured, `/api/sessions` combines the hosted list with the
sessions stored under `~/os1/sessions`. Local sessions win an id collision and
carry `local: true`. Session API calls are routed by ownership, so transcripts,
diffs, assets, Git and PR actions for hosted sessions go to the upstream while
new sessions remain local by default.

Live hosted-session traffic shares one lazy upstream WebSocket. Each local
browser socket gets an isolated virtual lane on that connection, so simultaneous
watches, cancels, direct replies, and terminals retain their own hosted socket
context. A disconnect closes the hosted virtual lanes; bounded reconnect restores
each watched session, while terminal processes exit instead of being replayed.

Without a token, the server makes no cloud requests. If the upstream is down,
the session list still returns local sessions and sets
`X-OpenSession-Cloud-Unreachable: true`; local sessions and local live work keep
running while the cloud WebSocket reconnects with a maximum 15-second delay. The
UI also shows a transient cloud-unreachable notice.

## Models

The local picker offers Anthropic models when Claude Code credentials are found
and OpenAI models when Codex credentials are found. Claude is preferred when
both are available; override the default for a run with, for example:

```sh
OPENSESSION_PROFILE=local \
OPENSESSION_MODEL=openai/gpt-5.5 \
bun run opensession.ts
```

Model ids run through the local subscription bridge. Automatic cross-provider
fallback is disabled in the local profile, so authentication or quota failures
remain visible instead of silently switching subscriptions.

Local utility calls such as generated titles and branch suggestions use the
same configured provider. For an OpenAI-only login, set `OPENSESSION_MODEL` as
shown above (or choose an OpenAI default in Settings).

## Local state

Defaults are isolated from a hosted OpenSession installation:

| Data | Default path |
| --- | --- |
| Config and repository registry | `~/os1/config.json` |
| Model preferences | `~/os1/default-model.json` |
| Sessions | `~/os1/sessions` |
| Session worktrees | `~/os1/worktrees` |
| Repositories cloned through the API | `~/os1/repos/<repo-id>` |
| Optional MCP configuration | `~/os1/mcp-config.json` |
| Claude Keychain bridge cache | `~/os1/auth/claude/.credentials.json` |
| Anthropic OpenCode isolation state | `~/os1/auth/opencode-anthropic/` |
| OpenAI access-only seeds | `~/os1/auth/opencode-openai/` |

Existing path, port, and binary overrides still win, including `OPENSESSION_CONFIG`,
`OPENSESSION_CHATS_DIR`, `OPENSESSION_WORKTREES_DIR`,
`OPENSESSION_MCP_CONFIG`, `OPENSESSION_OPENCODE_BIN`, and `PORT`. `HOST` is
restricted to `127.0.0.1`, `::1`, or `localhost` in local mode.

## macOS smoke test

With a throwaway Git repository available at `/Users/ada/code/local-test`:

```sh
OPENSESSION_PROFILE=local bun run opensession.ts

curl -sS http://127.0.0.1:3850/api/health
curl -sS http://127.0.0.1:3850/api/auth/status
curl -sS http://127.0.0.1:3850/api/repos \
  --json '{"path":"/Users/ada/code/local-test"}'
curl -sS http://127.0.0.1:3850/api/models
```

Then open <http://127.0.0.1:3850>, create an ask session, and create a code
session on a new branch. Verify that:

- The UI opens without GitHub sign-in or a name picker.
- The registered repository is selected.
- Only providers logged into through Claude Code or Codex appear in the picker.
- A model turn runs on that CLI subscription without an OpenCode login prompt.
- The code session's checkout appears under `~/os1/worktrees`.
- No files are created in the hosted profile's `~/.opensession-chats` store.

Stop the server with `Ctrl-C`. The profile is selected per process and does not
write a persistent mode setting.
