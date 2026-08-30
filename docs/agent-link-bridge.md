# agent-link bridge: surfacing live pi sessions in Open Session

**Status:** design sketch. Nothing implemented.

**Goal:** pi (and Claude Code) sessions started outside Open Session — from a
terminal, on this machine — appear in `/api/sessions` and can be read and
steered from every client, including the iOS app.

## Why this is a server change, not a client change

The Swift clients are thin readers of the REST/WS surface. `Session` in
`packages/clients/ios/OS1/Models/Session.swift` is documented as "a subset of
the server's UnifiedSession", decoded tolerantly — optionals everywhere,
unknown fields ignored. The app has no filesystem access to the host and can
only render what the server sends. Any work done in the app would have to be
repeated in the web UI, the PWA, the Electron shell and the Chrome extension.

Do it once in the server and all five clients inherit it.

## Why the runner is the wrong seam

Open Session already embeds Pi, but under an isolated state root:

```js
// pi-runner.ts
export const PI_STATE_DIR = stateDir("pi");          // ~/.opensession/pi
const sessionDir = `${PI_STATE_DIR}/sessions/${sanitizeId(unifiedSessionId || runKey)}`;
```

`findPiSessionFile()` scans exactly that one directory for a jsonl whose header
id matches a `piSessionId` Open Session recorded when it created the session.
It never looks at `~/.pi/agent/sessions/`, where the user's own pi sessions
live. There is no adopt/import/discover path anywhere in the server.

`docs/extending.md` is explicit that the runner is off-limits:

> **What not to extend. The runner.** `agent-runner.ts`, `pi-runner.ts` and
> `host-client.ts` are runner internals with a lot of load-bearing behaviour
> around restarts, reattachment and account rotation.

So: do not teach `pi-runner` about foreign sessions. Project them in at the
route layer instead.

## The shape already exists

Two pieces of precedent make this much smaller than it looks.

**1. Open Session's own agent mesh is the same concept.** Per
`docs/portals-and-agent-communication.md`, interactive sessions get
`opensession-sessions` tools. They line up almost one-to-one with agent-link:

| agent-link            | opensession-sessions       |
| --------------------- | -------------------------- |
| `list`                | `list_sessions`            |
| `send`                | `send_to_session`          |
| `ask`                 | `send_to_session` + wait   |
| `reply`               | `answer_session_question`  |
| `pending`             | the asks surface           |

The bridge is a second implementation of an interface the product already has,
not a new concept bolted on.

**2. `/api/sessions` already returns rows it does not own.** The route
synthesizes archived-index summaries with `source: "archive"` — rows that are
not live session records. Injecting foreign rows is an established pattern
here, not a violation of one.

`SessionSource` is a four-value union in both
`packages/core/opensession-server/src/server/types.ts` and the frontend copy:

```ts
export type SessionSource = "slack" | "linear" | "opensession" | "cli";
```

Add `"agent-link"`. The iOS client types `source` as `String?`, so no client
change is required for the rows to arrive and render.

## Design

### Extension point

Integrations (`docs/extending.md` §4) — an agent module that owns background
work and routes. Append to
`packages/core/opensession-server/src/server/integrations/registry.ts`:

```ts
{
  id: "agentlink",
  label: "Agent Link",
  doc: "docs/setup/agentlink.md",
  enableFlag: "ENABLE_AGENTLINK_AGENT",
  env: [
    { name: "AGENTLINK_SOCKET", description: "mesh socket; defaults to the CLI's" },
  ],
  load: async () => (await import("../../agents/agentlink/index")).AgentLinkAgent,
}
```

Registry rules that matter: array order is boot order, so **append**; a module
that throws on import is logged and skipped, never fatal. A dead mesh must not
take the server down.

### The missing seam

An integration cannot currently contribute rows to `/api/sessions`. That gap is
the actual work, and per `docs/extending.md` it is the right instinct:

> if you find yourself editing `opensession.ts`, that is usually a sign the
> thing you want is missing an extension point

Propose a narrow provider interface:

```ts
export interface ExternalSessionProvider {
  readonly source: SessionSource;      // "agent-link"
  list(): Promise<ExternalSession[]>;  // cheap, cached, never throws
  get(id: string): Promise<ExternalSessionDetail | null>;
  send(id: string, text: string): Promise<DeliveryReceipt>;
  answer?(id: string, text: string): Promise<DeliveryReceipt>;
}
```

`routes/sessions.ts` unions registered providers into the GET response exactly
where it already merges archive rows. Provider failure degrades to "no external
rows", never a 500.

### Field mapping

External sessions carry almost none of Open Session's metadata. Every absent
field is already optional on the wire and in the Swift model.

| Session field   | From agent-link                          |
| --------------- | ---------------------------------------- |
| `id`            | `agent-link:<mesh-name>` (namespaced)    |
| `title`         | mesh `name`, or first user turn          |
| `source`        | `"agent-link"`                           |
| `isRunning`     | mesh status                              |
| `waitingForInput`| has a pending inbound ask                |
| `repo`/`branch` | resolved from the peer's cwd if known    |
| `repoLess`      | `true` when cwd maps to no known repo    |
| `worktreeDir`   | peer cwd (read-only; not an OS worktree) |
| `archived`      | `false`                                  |

Add `external: true` and `readOnly: boolean` so clients can suppress affordances
Open Session cannot honor (archive, PR creation, worktree ops, deploy).

### Steering

`send_to_session` semantics — steer a live run when possible, otherwise queue —
map onto agent-link `send`. Open Session's guarantees are stronger than the
mesh's: it persists queued messages across restarts and returns a stable
delivery receipt. The bridge cannot promise that, because the peer process is
owned by a terminal and dies with it. **Report honestly**: return a receipt
marked non-durable rather than implying persistence the bridge does not have.

## Security

`docs/portals-and-agent-communication.md` draws a hard line:

> Security boundary: these cross-session controls exist only for trusted
> interactive runs. Automation-owned sessions get the scoped task suite when
> explicitly allowed, never the general session-control plane.

The bridge widens the blast radius and must be built fail-closed:

- **Mesh content is untrusted data.** A peer transcript is attacker-influenced
  (it contains whatever that agent read from the web, a diff, an issue). It is
  rendered, never interpreted as instruction. This is the same rule
  `docs/extending.md` states for every extension.
- **Automations must never see external sessions.** `list()` results must be
  withheld from automation runs, matching the existing boundary.
- **Never mint credentials for a peer.** External sessions get no AWS
  short-lived creds, no CLI account rotation, no MCP servers. They are a view
  and a message pipe.
- **This instance is currently unauthenticated on the LAN** (`0.0.0.0:3850`,
  `{"required":false}`). Bridging local terminal agents into it means anyone on
  the network can read those transcripts and send them turns. Enable GitHub
  sign-in before enabling this integration.

## Staged plan

1. **Read-only list.** Integration + provider seam + `source: "agent-link"`
   rows. No transcript, no steering. Proves the union and the client tolerance.
2. **Transcript.** `get()` maps pi's jsonl to the transcript wire format. See
   `docs/transcripts.md` and `docs/transcript-snapshots.md`.
3. **Steering.** `send()` via mesh `send`; surface pending asks through the
   existing asks UI so a blocked peer is answerable from the phone.
4. **Historical sessions.** Scan `~/.pi/agent/sessions/` (organized by working
   directory) for ended sessions. Read-only, no mesh involvement — strictly
   easier than 1–3 and independently useful.

## Open questions

- **Identity.** Open Session attributes agent messages as `agent <session-id>`,
  never as the human. What is a mesh peer's identity, and whose permissions
  does a turn sent from the phone run under?
- **Lifecycle.** Peers vanish when a terminal closes. Reconciliation and
  staleness policy — do dead peers linger as history or disappear?
- **Machine scope.** agent-link is machine-local. A remote Open Session
  instance cannot see this mesh at all.
- **Upstream.** `CONTRIBUTING.md` asks for issues describing the change rather
  than code. If this is meant for mainline, open an issue first; the
  `ExternalSessionProvider` seam is the part worth agreeing on before building.
