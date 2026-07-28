# Feeds: external objects as first-class workspace sources

Status: Phase 0 (Tella prototype) in progress (2026-07-28). Owner: Michiel;
implementation: Michael sessions.

## Thesis

OpenSession's core should be exactly three primitives: **workspaces, sessions,
tabs**. Everything else — Plain tickets, PRs, Tella videos, any future MCP/API —
is a **package** that contributes up to five things:

1. a **feed** — a sidebar band of external items (tickets, videos, PRs)
2. a **resolver** — item → workspace (adopt-don't-duplicate, dedupe key `<kind>-<id>`)
3. **panels** — tabs a workspace can show (conversation timeline, web/iframe editor)
4. **tools** — an MCP server (already generic via mcp-config.json)
5. **events** — webhooks → automations (already generic via AgentModule + eventKey)

"Everything is sessions" is really "everything is a workspace": a feed item
resolves into one workspace; sessions and tabs are children of that workspace.

## Why now: rule of three

Plain, PRs, and (soon) Tella videos all independently implement the same
pattern with bespoke code. Audit findings (2026-07-28, full detail below):
Plain is NOT a session source like Slack/Linear — it's a parallel object feed
(`SupportThread`, 60s poll) + one foreign key (`plainThreadId`) + a fake
sidebar project band + a conversation tab + a workspace resolver + webhook
events. That accidental shape IS the generic contract; it just needs
extracting.

## Phases

- **Phase 0 (CURRENT): Tella prototype, aimed at the contract.** Don't
  generalize Plain yet, but build the generic pieces Tella needs: FeedItem/
  FeedDescriptor types, feed registry, `/backstage/api/feeds*` routes, generic
  `externalRefs: {kind,id,...}[]` on workspace/session, sidebar feed band
  rendered from a descriptor (parameterize `renderPlainProject`'s shape, don't
  migrate Plain). Tella feed provider for "my recent videos" (Tella API; key
  in `~/.opensession.env` `TELLA_API_KEY`, MCP docs at
  https://www.tella.com/docs/mcp-server), `tella-<videoId>` workspace
  adoption, Tella MCP in mcp-config with allowedUsers + auto-include for
  sessions whose workspace carries a tella ref, **Editor tab as a generic web
  panel** (`{kind:"web", url}`). RISK: tella.tv/video/:id/edit likely won't
  iframe (frame-ancestors + third-party cookies). We own Tella → carve out
  `frame-ancestors https://os.tella.dev` in tella-fusion. Test iframability
  FIRST; fallback = open-in-new-tab + embedded read-only player.
  Automations: `tella:video_created` → draft title/chapters/description from
  transcript (analogue of plain:thread_created triage) — can trail the
  prototype.
- **Phase 1: migrate Plain onto the generic contract.** Plain feed provider +
  priority lanes + row actions; kill the hardcoded `renderPlainProject`
  splice; conversation panel becomes a registered panel kind bound to
  `{kind:"plain"}` refs; compat: keep reading+writing `plainThreadId`. Keep
  the 13 `/api/plain/*` mutation routes as-is (strangler). If Plain fits
  without the contract growing Plain-shaped warts, the abstraction is real.
- **Phase 2: "any MCP is a project".** Config-declared feed adapter: name an
  MCP server + a list-tool + field mapping → sidebar band with zero core
  code. This is the open-source `@opensession/*` demo story.

Packages: do NOT build a package system first. Extend `AgentModule`
(src/agents/types.ts) with optional feed/panel contributions; prototype lives
in `src/agents/tella/` like Plain. The interface is the package boundary;
extraction to `@opensession/feed-*` workspaces later is mechanical.

## Contract sketch

```ts
type ExternalRef = { kind: string; id: string; url?: string; title?: string };
// on BackstageSessionFile + UnifiedSession + Workspace, alongside legacy plainThreadId

type FeedItem = {
  id: string;            // stable external id (plain threadId, tella videoId)
  title: string;
  preview?: string;
  lane?: string;         // key into descriptor.lanes (plain: priority; tella: recency/status)
  ts?: number;           // sort key
  url?: string;          // canonical external link
  thumbnail?: string;    // hover-card use (videos)
  meta?: Record<string, unknown>; // source-specific (labels, assignee) for filters/actions
};

type FeedDescriptor = {
  id: string;            // "plain", "tella"
  title: string;
  refKind: string;       // ExternalRef.kind stamped on adopted workspaces
  lanes?: { key: string; label: string; dot?: string }[];
  tile?: { bg?: string }; // BrandTile color; icon via /backstage/repo-icon/:id.png path
};

// server registry (src/server/feeds.ts):
registerFeed(descriptor, provider: { listItems(): Promise<FeedItem[]> });
// routes: GET /backstage/api/feeds → descriptors; GET /backstage/api/feeds/:id/items
```

Panel registry (frontend): map `ExternalRef.kind` → panel renderer.
`"plain"` → ConversationPane (existing PlainThreadPanel), `"web"` →
sandboxed iframe. The `ViewTab[]` strip in App.tsx is already data-driven;
generalize the producer that currently synthesizes the "conversation" tab
from `plainThreadId` to iterate `externalRefs`.

## Key existing code (audit 2026-07-28)

Plain-specific hardcodings to migrate/absorb:
- `plainThreadId` on server/types.ts:415 (UnifiedSession), :143 (session file),
  workspaces.ts:65 (Workspace); `archivedReason:"plain"` in a shared enum.
- Sidebar.tsx: `SupportThread` fetch loop ~:1637; `SupportRow` ~:269;
  `SUPPORT_PRIORITY_GROUPS` ~:246; `renderSupportLanes` ~:3872;
  `renderPlainProject` ~:4030; hardcoded splice into render array ~:4966-4987;
  `support:` pin prefix ~:4676; `SupportFilterState` ~:382.
- routes/plain.ts: `GET /api/plain/threads` (30s cache) is what the feed
  provider replaces; the 12 other mutation/metadata routes STAY.
- `resolvePlainWorkspace` (workspace-resolve.ts:185-230), dedupe `plain-<id>`;
  `workspaces/resolve` route already a discriminated union (pr | plainThreadId).
- `PLAIN_WORKSPACE_ID` hardcoded in PlainThreadPanel.tsx:41 +
  SessionViewer.tsx:328.
- repo-icon route `if (id === "plain")` (static-assets.ts:87); BrandTile.tsx:8.

Already-generic seams to build on: AgentModule + agents-registry (webhooks),
fireAutomationsForEvent/eventKey, mcp-config.json + connections.ts,
workspace adopt-don't-duplicate + stampWorkspaceIdentity, ViewTab[] strip,
sidebar row conventions (`sidebar-item sidebar-ws-row`, RepoTile, hover cards).

## Honest caveats

- A video's primary artifact is the editor (human), not a text thread
  (agent-native like Plain). Tella workspaces are "human tab + agent session
  side by side"; the agent works the periphery (transcript, metadata, clips,
  distribution). Don't pretend a video is a conversation — the panel model
  absorbs the difference.
- Feed data transport: v1 feed providers are server-side code (REST or MCP
  underneath); "sidebar literally driven by MCP tools" is Phase 2, not v1.
- Backend changes here (routes, registry, resolver) need a real
  `systemctl restart opensession`; sidebar/panel changes rebuild live.
