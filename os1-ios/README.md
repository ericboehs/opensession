# OS1 for iOS

A native SwiftUI client for an OpenSession (OS1) server, on your phone. The
deployment default is the `OS1DefaultServerURL` Info.plist value generated from
`project.yml`; users can override it in Settings. Not feature complete; this is
the v0.1 base: sign in with a token, see your sessions live, open one, watch
the agent stream, send prompts, and answer blocking questions.

Pure SwiftUI with SwiftStreamingMarkdown for CommonMark/GFM rendering, iOS 26+
(see `project.yml` for the authoritative deployment targets).

## Features (v0.1)

- **Sessions list** — polls `GET /api/sessions` every 5s (matching the web UI);
  flat single-line workspace rows with live/PR status marks and a running-time
  ticker, larger mobile type, and the web client's warm dark palette, plus
  grouping with the web sidebar's shared, drag-to-reorder repository order,
  compact toolbar search/filter, iOS long-press worktree actions (details,
  rename, sharing, pull request, and archive), swipe-to-archive, restore from the
  archived list, a floating create button, and pull to refresh.
- **Session view** — live transcript over the `/ws` WebSocket: user/assistant
  messages in the same neutral, repo-aware visual hierarchy as mobile web
  (streaming CommonMark/GFM with links, tables, and highlighted code blocks),
  compact tool-call rows, system events, token-level streaming via
  `stream_text` with a cursor bubble, and a horizontally scrollable chat tab
  strip when a workspace/worktree contains multiple sessions. A bounded cache
  keeps recently visited conversations loaded while their off-screen sockets
  remain disconnected, so returning to a page does not show a loading screen.
- **Workspace details** — tapping the chat title opens a native worktree sheet
  with repository and branch metadata, local git status, changed files, pull
  request status, workspace context, and model/reasoning controls, matching
  mobile web's info page without embedding the web client.
- **Prompting** — WS `prompt` frames (the server has no REST prompt endpoint).
  Sending while a run is active queues, exactly like the web UI. Stop button
  sends `cancel` for the watched session. The floating glass composer uses a
  progressive material fade so transcript content recedes cleanly beneath it;
  its full surface focuses the field and keeps a comfortable keyboard gap.
- **Session creation** — a full-height prompt editor with image attachments and
  a compact single-row iOS toolbar for repository, mode, and model settings.
- **AskUserQuestion** — blocking questions render as an inline card with option
  buttons + free-text answer, wired to `answer_question`.
- **PR panel** — sessions with a pull request expose a row in the title-opened
  workspace sheet; it opens a read-only panel with state, review decision,
  conflicts, every check with its status, and reviewers, via
  `GET /api/sessions/:id/pr`. Actions (merge/review) stay on the web UI.
- **Connection care** — client-initiated pings every 20s (the server never
  pings; required against half-open iOS sockets), auto-reconnect with a banner,
  optimistic local echo of your prompts until the server's copy arrives.
- **Settings** — native SwiftUI Tools, Personal, and Workspace administration,
  plus server/GitHub/token configuration and a connection test. Cross-device
  composer and chat preferences refresh at launch and when the app foregrounds.

## Signing in

Settings has in-app GitHub device-flow sign-in (`GitHubAuth.swift` —
`POST /api/auth/device`, then `/api/auth/device/poll` with `native: true`;
the server mints a web-session token and returns it in the poll body). The
token is kept in the keychain and rides as `Authorization: Bearer <token>`
everywhere, including the WebSocket upgrade. Pasting a token manually still
works as a fallback: tokens are the `opensession_auth` cookie values minted
at web sign-in, stored server-side in `~/.opensession-web-sessions.json`.

## Build

On a Mac:

```sh
brew install xcodegen
cd os1-ios
xcodegen generate
open OS1.xcodeproj
```

Then run the `OS1` scheme on iOS 26+.

## Architecture

```
OS1/
  OS1App.swift               App entry; forces Settings on first run
  NativePreferences.swift    Cross-device preference hydration/cache
  NativeNotifications.swift  Local notifications for finished/blocked runs
  PlatformCompat.swift       iOS/macOS API bridging shims
  Models/
    Session.swift            Tolerant subset of the server's UnifiedSession
    TranscriptEntry.swift    Transcript entry (REST + WS frames)
    AskQuestion.swift        Pending AskUserQuestion
    AttachedImage.swift      Composer image attachments
    ModelCatalog.swift       Model/reasoning options from /api/models
    PrDetails.swift          PR panel payload
    SettingsModels.swift     Settings payloads (tools/personal/workspace)
  Networking/
    ServerConfig.swift       URL/name (UserDefaults) + token (keychain)
    Keychain.swift           Minimal Security wrapper
    GitHubAuth.swift         GitHub device-flow sign-in
    OS1API.swift             REST reads (sessions, transcript, health)
    SettingsAPI.swift        Settings reads/writes
    ServerEvent.swift        WS frame parsing (unknown types -> .ignored)
    OS1Socket.swift          WebSocket: bearer auth, ping loop, typed events
  ViewModels/
    SessionsListViewModel.swift  5s polling
    SessionViewModel.swift       watch/stream/prompt/ask state machine
    SessionViewModelCache.swift  Bounded recently visited conversation cache
  Views/
    OS1VisualStyle.swift      Shared web palette, chat width, and repo tile
    SessionsListView.swift   List + status rows + settings sheet
    SessionView.swift        Transcript, streaming bubble, ask card, input bar
    NewSessionView.swift     Full-height create-session editor
    TranscriptRow.swift      Per-entry-type rendering + streaming markdown
    MarkdownBody.swift       Streaming/durable markdown rendering
    AskQuestionCard.swift    Options + free text answer
    PrPanel.swift            Read-only pull-request panel
    WorktreeInfoView.swift   Workspace details sheet
    SettingsView.swift       Native settings index + connection controls
    Native*SettingsViews.swift  Native Tools, Personal, Workspace panels
    MacSettings.swift        macOS settings window
    Glass · ImageAttachments · UserAvatar · WebIcon  smaller shared views
```

## Protocol notes (from the server source)

- Public paths are prefix-less: REST at `/api/...`, WebSocket at `/ws`.
- WS handshake: server sends `{"type":"hello","bootId":...}` first; the client
  sends `watch` only after that, so it can't race the upgrade.
- `transcript_init` replaces the tail, `transcript_history` prepends,
  `transcript_append` upserts by entry id (overlap expected, ~1s cadence).
- `stream_text` deltas render immediately; the durable assistant entry arrives
  via `transcript_append` after `stream_done`, at which point the live bubble
  is dropped.
- Entries can arrive clamped (`contentClamped`); full content is at
  `GET /api/sessions/:id/entry/:entryId` (not wired into the UI yet).

## Next milestones

- Resume cursors (`sinceOffset`/`sinceRev`) for cheap reconnects
- Image attachments in assistant markdown
- Push-style updates for the sessions list (it polls today)
