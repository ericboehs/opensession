# OS1 for iOS

A native SwiftUI client for the OpenSession (OS1) server — the sessions
dashboard at https://os.tella.dev, on your phone. Not feature complete; this is
the v0.1 base: sign in with a token, see your sessions live, open one, watch
the agent stream, send prompts, and answer blocking questions.

Pure SwiftUI, zero dependencies, iOS 17+.

## Features (v0.1)

- **Sessions list** — polls `GET /api/sessions` every 5s (matching the web UI);
  status dot (green running / orange needs-input), repo + branch, queued count,
  relative last-activity time, pull to refresh.
- **Session view** — live transcript over the `/ws` WebSocket: user/assistant
  bubbles (inline markdown), compact tool-call rows, system events, and
  token-level streaming via `stream_text` with a cursor bubble.
- **Prompting** — WS `prompt` frames (the server has no REST prompt endpoint).
  Sending while a run is active queues, exactly like the web UI. Stop button
  sends `cancel` for the watched session.
- **AskUserQuestion** — blocking questions render as an inline card with option
  buttons + free-text answer, wired to `answer_question`.
- **Connection care** — client-initiated pings every 20s (the server never
  pings; required against half-open iOS sockets), auto-reconnect with a banner,
  optimistic local echo of your prompts until the server's copy arrives.
- **Settings** — server URL + display name (UserDefaults) and bearer token
  (keychain), with a connection test.

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

Then run the `OS1` scheme on iOS 17+.

## Architecture

```
OS1/
  OS1App.swift               App entry; forces Settings on first run
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
    SessionsListView.swift   List + status rows + settings sheet
    SessionView.swift        Transcript, streaming bubble, ask card, input bar
    TranscriptRow.swift      Per-entry-type rendering + MarkdownText
    AskQuestionCard.swift    Options + free text answer
    SettingsView.swift       Server/token/name + connection test
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
- Block-level markdown (code fences) and image attachments
- Push-style updates for the sessions list, PR status on rows
