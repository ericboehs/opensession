# @tellahq/opensession-protocol

The TypeScript wire and record contracts used by the
[Open Session](https://opensession.com) server and web UI, and mirrored by the
native Swift client. The wire formats are language-neutral, but this is
currently a private Bun workspace package exported as TypeScript source, not a
published npm package.

## `./runner` — detached run hosts

The contract between the server and a **run host**, a process that owns one
agent run. This is not the persistent machine called a Runner in Settings;
paired Runners currently provide command delegation, not full session hosting.
The server or a configured sandbox provider launches run hosts and supplies
their per-run credentials. This package does not provide third-party host
registration or launch discovery.

`RunHostSpec` describes the run. `HostToClientMsg` sends `hello`, `event`,
`ask`, `transcript`, `end`, and transport frames to the server;
`ClientToHostMsg` sends steering, cancellation, ask answers, acknowledgements,
and shutdown back to the host.

Detached local hosts currently require Linux and systemd. They serve a Unix
socket using newline-delimited JSON; `ndjsonReader` is the reference reader.
Other local runs can execute in the server process. Remote and WebSocket-mode
sandbox hosts dial the authenticated `/run-ws/<hostId>` route and send one JSON
object per WebSocket text frame. WebSocket event replay is bounded to 5,000
frames and 5 MiB plus one oversized frame. Overflow reports a `gap`, and a full
server restart starts a new replay epoch. The Unix-socket stream is live-only. Durable transcript
entries are written by the server or relayed to its transcript store with
`transcript` frames; a run host must not open the server's transcript database.

The host boundary is designed around the engine-neutral `StreamEvent` shape,
but Pi is the only current production execution engine. Anthropic and OpenAI
models both route through Pi; `claude` and `codex` provider tags remain for
stored-data compatibility.

## `./session` — session clients

The contract between a session client and the server: durable record types such
as `TranscriptEntry`, `SessionUsage`, and `AskQuestion`, plus the core
WebSocket frames `ProtocolClientMessage` and `ProtocolServerMessage`.

Clients connect to `/ws`. When per-user authentication is enabled, the upgrade
uses the same-origin session cookie or an `Authorization: Bearer <token>`
header. The first server frame is `hello`; clients should use the application
`ping`/`pong` frames to detect half-open connections.

A current client should send `watch` with `supportsSeq: true` and
`supportsChangeSeq: true`. It receives a `transcript_init`, then
`transcript_append` updates and `transcript_history` pages requested with
`load_history`. Without seq support, a server-owned transcript may degrade to a
truncated legacy tail without an earlier-history cursor. Indexed clients can
also advertise `supportsTranscriptIndex` and hydrate ranges with
`load_transcript_range`. Entries with `contentClamped` expose their full record
at `GET /api/sessions/:sessionId/entry/:entryId`.

Clients that advertise `supportsFeed` receive ordered live-turn events inside
`session_feed` and resume with `feedEpoch` and `sinceFeedSeq`; other clients
receive the same `stream_*`, `transcript_append`, and `session_status` event
shapes at the top level. Prompt, interrupt, cancel, queue control, and
human-in-the-loop ask frames drive the session. Mutation frames should keep a
stable `requestId` across reconnects; when `hello.capabilities.commandResults`
is true, retire them on terminal `command_result` and acknowledge that result
with `command_ack`.

The reference web UI adds collaborative notes, terminals, presence, and change
notifications to its own message unions over the same socket. Those app frames
are deliberately outside the core session unions. The Chrome extension uses
the REST API rather than this WebSocket contract.

## `./events` — run events

Events emitted while a run executes: `init`, `text_chunk`, `tool_use`,
`tool_result`, `usage_snapshot`, `model_switch`, `runner_notice`, and terminal
`done` or `error`, with `TurnUsage` accounting.

## `./executor` — local launch control

The versioned, authenticated NDJSON contract between the server and the local
executor sidecar. It can launch, inspect, or stop a persisted run-host spec by
host id and SHA-256. It is intentionally not a remote shell and accepts neither
arbitrary commands nor caller-selected paths. The Unix socket is
`executor.sock` in the active sessions directory.

## Shared derivations

The package also exports shared behavior used on both sides of the wire:
`./live-text` and `./stream-cuts` for live rendering, `./notices` and
`./tool-presentation` (with `./todo-plan`) for transcript projection,
`./workspace-group` for workspace membership, and `./identity` for Git
attribution.

## Compatibility

Fields are added, never repurposed. Clients must ignore unknown keys and frame
types. The canonical random session-id prefix is `os-`, but compatibility and
deterministic-id paths still emit and accept `bks-`. Current routes are
unprefixed, while the server continues to normalize the historical
`/opensession/*` and `/backstage/*` forms. Removing those compatibility forms
would break stored transcripts, links, and running dial-back URLs.
