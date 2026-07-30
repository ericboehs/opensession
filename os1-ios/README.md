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
  compact toolbar
  search/filter, swipe-to-archive, restore from the archived list, a floating
  create button, and pull to refresh.
- **Session view** — live transcript over the `/ws` WebSocket: user/assistant
  messages in the same neutral, repo-aware visual hierarchy as mobile web
  (streaming CommonMark/GFM with links, tables, and highlighted code blocks),
  compact tool-call rows, system events, token-level streaming via
  `stream_text` with a cursor bubble, and a horizontally scrollable chat tab
  strip when a workspace/worktree contains multiple sessions.
- **Workspace details** — tapping the chat title opens a native worktree sheet
  with repository and branch metadata, local git status, changed files,
  workspace context, and model/reasoning controls, matching mobile web's info
  page without embedding the web client.
- **Prompting** — WS `prompt` frames (the server has no REST prompt endpoint).
  Sending while a run is active queues, exactly like the web UI. Stop button
  sends `cancel` for the watched session. The floating glass composer uses a
  progressive material fade so transcript content recedes cleanly beneath it.
- **AskUserQuestion** — blocking questions render as an inline card with option
  buttons + free-text answer, wired to `answer_question`.
- **PR chip + panel** — sessions with a pull request show a toolbar chip
  (number + status dot: merged/closed/draft, or the check rollup while open);
  tapping it opens a read-only panel with state, review decision, conflicts,
  every check with its status, and reviewers, via
  `GET /api/sessions/:id/pr`. Actions (merge/review) stay on the web UI.
- **Connection care** — client-initiated pings every 20s (the server never
  pings; required against half-open iOS sockets), auto-reconnect with a banner,
  optimistic local echo of your prompts until the server's copy arrives.
- **Settings** — native SwiftUI Tools, Personal, and Workspace administration,
  plus server/GitHub/token configuration and a connection test. Cross-device
  composer and chat preferences refresh at launch and when the app foregrounds.

## Getting a token

The server accepts `Authorization: Bearer <token>` everywhere, including the
WebSocket upgrade. Tokens are the `opensession_auth` cookie values minted at
web sign-in, stored server-side in `~/.opensession-web-sessions.json`. Grab
yours from the browser cookie (or that file) and paste it into Settings.
In-app GitHub device-flow sign-in (`POST /api/auth/device`) is the planned
replacement for the paste step.

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
  Models/
    Session.swift            Tolerant subset of the server's UnifiedSession
    TranscriptEntry.swift    Transcript entry (REST + WS frames)
    AskQuestion.swift        Pending AskUserQuestion
  Networking/
    ServerConfig.swift       URL/name (UserDefaults) + token (keychain)
    Keychain.swift           Minimal Security wrapper
    OS1API.swift             REST reads (sessions, transcript, health)
    ServerEvent.swift        WS frame parsing (unknown types -> .ignored)
    OS1Socket.swift          WebSocket: bearer auth, ping loop, typed events
  ViewModels/
    SessionsListViewModel.swift  5s polling
    SessionViewModel.swift       watch/stream/prompt/ask state machine
  Views/
    OS1VisualStyle.swift      Shared web palette, chat width, and repo tile
    SessionsListView.swift   List + status rows + settings sheet
    SessionView.swift        Transcript, streaming bubble, ask card, input bar
    TranscriptRow.swift      Per-entry-type rendering + streaming markdown
    AskQuestionCard.swift    Options + free text answer
    SettingsView.swift       Native settings index + connection controls
    Native*SettingsViews.swift  Native Tools, Personal, Workspace panels
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

- GitHub device-flow sign-in (no token pasting)
- Resume cursors (`sinceOffset`/`sinceRev`) for cheap reconnects, and
  `load_history` paging for older transcript
- Create session, queue management (edit/delete/steer queued prompts)
- Image attachments in assistant markdown
- Push-style updates for the sessions list, PR status on rows
