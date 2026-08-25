# Slack

The Slack agent (`packages/core/opensession-server/src/agents/slack/`) is the main chat surface: DMs and
@-mentions become agent runs, worktree channels drive coding sessions, and
watched channels fire automations.

## Creating the app (manifest)

Don't tick scopes by hand. **Settings → Setup → Slack** generates an
app manifest from this instance's own configuration and opens Slack's
"Create new app → From a manifest" flow with it pre-loaded
(`src/frontend/lib/slack-manifest.ts`). The manifest carries the bot scopes,
the bot event subscriptions, interactivity, the public UI domain for session-link
unfurls, and — for the HTTP transport — the two request URLs derived from the
instance's webhook base.

Pick the transport in that dialog before creating the app: **Socket Mode**
emits `socket_mode_enabled: true` and no request URLs, **HTTP** emits
both `/slack/events` and `/slack/actions`. The JSON is also copyable, for
pasting into an existing app under **App Manifest**.

A manifest cannot carry credentials. After creating and installing the app you
still paste the bot token (and either the app-level token or the signing
secret) into the setup dialog by hand.

## Tokens and env vars

Outbound Web API calls always use the **bot token** (`xoxb-…`). Event intake
runs one of two transports: Socket Mode (an outbound WebSocket, no inbound
exposure) when an **app-level token** (`xapp-…`) is set, otherwise the HTTP
Events API guarded by the **signing secret**. See
[Event intake](#event-intake-socket-mode-or-http) below.

| Var | Required | Notes |
| --- | --- | --- |
| `SLACK_BOT_TOKEN` | yes | `xoxb-…`; used as Bearer for every Web API call (`packages/core/opensession-server/src/agents/slack/slack-api.ts`). Missing → the agent loads and every Slack call fails with logged auth warnings (no crash) |
| `SLACK_APP_TOKEN` | for Socket Mode | `xapp-…` app-level token with `connections:write`. When set, the agent runs Socket Mode (`packages/core/opensession-server/src/agents/slack/socket-mode.ts`) and registers no `/slack/events` or `/slack/actions` HTTP routes. Leave unset to keep the HTTP transport |
| `SLACK_SIGNING_SECRET` | HTTP transport only | HMAC verification of `/slack/events` and `/slack/actions`; missing → real Slack requests fail verification → 401, so HTTP event intake is dead. Unused (and not needed) in Socket Mode |
| `ALLOWED_SLACK_USER_ID` | recommended | admin gating, see below. **Unset = everyone is admin** (fail-open) |
| `WORKTREE_HOOK_SECRET` | for `/worktree/*` hooks | shared secret; fail-closed (empty → all worktree-hook requests rejected) |
| `SLACK_MENTION_INTENT_MODEL` | no | mention intent-router model, default `claude-haiku-4-5` |
| `SCHEDULE_WHEN_MODEL` | no | natural-language schedule parsing, default `claude-haiku-4-5` |

The agent is off unless enabled: `integrations.slack.enabled: true` in
`~/.opensession/config.json`, or the `ENABLE_SLACK_AGENT` env flag (which
wins when set — see
[integrations-misc.md](integrations-misc.md#boot-guards)).

## Event intake: Socket Mode or HTTP

The agent picks its transport from configuration. Both feed the same shared
dispatch (`dispatchSlackEvent` / `dispatchSlackInteractive` in
`agents/slack/index.ts`), so the two paths behave identically once a payload
arrives. The event subscriptions the code consumes are the same either way:
`message.im` (DMs), `app_mention`, `link_shared` (session-link unfurls), and
plain `message` events in channels (for session-linked mirroring and
watched-channel automations).

### Socket Mode (recommended for simple installs)

Set `SLACK_APP_TOKEN` and the agent opens an outbound WebSocket to Slack
(`apps.connections.open` → dial the returned `wss://` URL). Slack pushes the
same Events API and interactivity payloads down that socket, wrapped in
envelopes. This needs **no inbound internet exposure**: no public URL, no
reverse proxy, no signing secret. Every envelope that carries an `envelope_id`
is acked immediately (before the work) so Slack does not retry; Slack rotates
the socket roughly hourly and redelivers on reconnect, so nothing is buffered.

To set it up in your Slack app:

1. **Socket Mode** → toggle **Enable Socket Mode** on.
2. **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**,
   add the `connections:write` scope, and copy the `xapp-…` token into
   `SLACK_APP_TOKEN`.
3. Under **Event Subscriptions** and **Interactivity & Shortcuts**, keep the
   same subscriptions and enable interactivity, but you can leave the Request
   URLs blank. Socket Mode delivers both.

With `SLACK_APP_TOKEN` present the agent registers no `/slack/events` or
`/slack/actions` HTTP routes at all.

### HTTP Events API

Leave `SLACK_APP_TOKEN` unset and the agent registers routes on the
[public ingress gateway](install.md#public-ingress) (`127.0.0.1:3860`
behind Funnel, Cloudflare Tunnel, or Caddy):

- `POST /slack/events` — Events API callbacks (handles Slack's
  `url_verification` challenge)
- `POST /slack/actions` — Block Kit interactivity
- `POST /worktree/create-channel`, `POST /worktree/archive-channel`
- `POST /github/webhook` only when GitHub is disabled. This is a compatibility
  fallback using GitHub's shared handler; when GitHub is enabled, GitHub owns
  the route (see [github.md](github.md)).

Point your Slack app's Event Subscriptions and Interactivity request URLs at
the first two, and set `SLACK_SIGNING_SECRET`. Events are acked 200 immediately
and handled async, with persisted dedup so Slack retries don't double-run. The
`/github/webhook` and `/worktree/*` routes are registered under both transports.

## OAuth scopes

Derived from the Web API methods the code actually calls
(`slack-api.ts`, `worktree-channels.ts`, `github-reviews.ts`, `index.ts`,
`streamer.ts`): `auth.test`, `chat.postMessage`, `chat.update`,
`chat.startStream`/`appendStream`/`stopStream`,
`assistant.threads.setStatus`/`setSuggestedPrompts`, `reactions.add`/
`remove`, `conversations.history`/`replies`/`info`/`open`/`list`/`create`/
`archive`/`setTopic`/`join`/`invite`, `users.info`, `views.open`.

Bot token scopes to grant:

- `chat:write`, `chat:write.customize`
- `files:write` (merged visual-change screenshots)
- `reactions:write`
- `app_mentions:read`
- `links:read`, `links:write` (session-link unfurls)
- `emoji:read` (custom workspace emoji)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`
- `channels:manage`, `groups:write` (create/archive/topic/invite worktree
  channels), `channels:join`
- `im:write`
- `users:read`
- `assistant:write` (assistant threads + streaming)

The bot must be a member of a channel to read its history and to share files;
the code calls `conversations.join` for channels it manages, but invite it to
any pre-existing channel you want it to read or post shipped changes into.

Socket Mode adds one method, `apps.connections.open`, called with the
app-level token rather than the bot token. Its scope, `connections:write`, is
granted on the app-level token itself (Basic Information → App-Level Tokens),
not in the bot scope list above.

## Who can drive it (`ALLOWED_SLACK_USER_ID`)

`packages/core/opensession-server/src/agents/slack/handlers.ts`:

- DMs and mentions are ignored unless the sender matches
  `ALLOWED_SLACK_USER_ID` — **except** mentions in worktree channels or
  channels linked to an Open Session session, where the whole team can drive.
- `isAdmin = !ALLOWED_SLACK_USER_ID || sender === ALLOWED_SLACK_USER_ID`.
  Admin unlocks the mutating tools of the in-process MCP servers
  (`opensession-admin` self-management, session control, goals, human-asks);
  non-admins keep the read-only subsets.
- Leaving it unset makes every workspace member an admin. Set it.

## What triggers what

- **DM** → conversational agent run.
- **@-mention** → intent-classified (haiku): PR action, read-only "ask" in
  thread, or "code" (new worktree + dedicated channel).
- **Message in a session-linked channel** → mirrored into the session's chat
  panel; an @-mention there steers the linked session.
- **Top-level message in a watched channel** → fires channel-watch
  automations (thread replies and bot posts don't).

## Channel memory

`packages/core/opensession-server/src/agents/slack/memory.ts`, stored under
`~/.opensession-memory/`, one JSON file per scope,
injected into the system prompt each run and edited via the admin
`remember`/`list_memory`/`forget` tools:

- public channel → shared `workspace.json`
- private channel → isolated `channel-<id>.json` + read-only workspace view
- DM → isolated `user-<id>.json` + read-only workspace view

## Channel IDs

No channel or user id is compiled in. Everything that posts to Slack resolves
its destination from config, and an unset channel means that particular
message is skipped rather than misdelivered:

| Setting | Used for |
| --- | --- |
| `integrations.slack.workspaceId` | building `app.slack.com` deep links in session labels |
| `integrations.slack.channelNames` | channel-id→name map for rendering transcripts |
| `integrations.github.docsSyncChannel` | where docs-sync announces its PRs |
| `integrations.github.shippedChangesChannel` | where merged visual changes are shared with their walkthrough screenshot |
| `grafanaPoll.slackChannel` (per-automation poll config) | Grafana-poller failure cards ([integrations-misc.md](integrations-misc.md#grafana-poller)) |

Identity mapping (Slack id → person, for attribution and per-user MCP
gating) is **not** hardcoded: it derives from `identity.team` /
`identity.slackNames` in `~/.opensession/config.json`
([install.md](install.md#5-opensessionconfigjson)); with no configured team
the mapping tables are empty and attribution/gating become no-ops.
