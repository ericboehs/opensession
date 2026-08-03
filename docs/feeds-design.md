# Feeds: external objects as first-class workspace sources

> Design history — describes the state when written.

Status: Phase 0 core LANDED 2026-07-28 (595d7eb6 backend contract + Tella
provider, 5cbcd284 sidebar bands + Video tab; verified live). Remaining
Phase-0 follow-ups: Tella MCP mount for tella-ref sessions (server is OAuth
2.1 at https://api.tella.com/mcp — needs interactive auth, not the API key),
frame-ancestors carve-out PR in tella-fusion so the Editor itself can iframe
(embed page iframes today), tella:video_created webhook → automation.

Note: the Tella MCP/feed provider used throughout this doc is an **optional
example integration** — the first reference implementation of the package
contract, not a required part of OpenSession. Instances without a Tella
account simply don't configure it.

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
  `{kind:"plain"}` refs; compat: keep reading+writing `plainThreadId`.
  ALSO (decided 2026-07-28): make the Phase-0 "video" view-tab fully generic —
  a web-panel tab driven by a panel registry (seed: `refWebPanel` in
  FeedWebPane.tsx), not a hardcoded `"video"` ActiveViewTab value/label. Keep
  the 13 `/api/plain/*` mutation routes as-is (strangler). If Plain fits
  without the contract growing Plain-shaped warts, the abstraction is real.
- **Phase 2: "any MCP is a project".** Config-declared feed adapter: name an
  MCP server + a list-tool + field mapping → sidebar band with zero core
  code. This is the open-source `@opensession/*` demo story.

Packages: do NOT build a package system first. Extend `AgentModule`
(src/agents/types.ts) with optional feed/panel contributions; prototype lives
in `src/agents/tella/` like Plain. The interface is the package boundary;
extraction to `@opensession/feed-*` workspaces later is mechanical.

## Scratch mode (landed fc1eba52, 2026-07-28)

Feed-item workspaces start chats in session mode `"scratch"`: like ask (no
repo/worktree/branch/PR flow) but with code-mode permissions — Write/Edit,
bash (ffmpeg, curl, downloads), MCP tools — in a per-WORKSPACE scratch dir
`~/.opensession-scratch/<workspaceId>` (sibling chats share downloads;
`ensureScratchDir` in worktree.ts). The opening prompt names the workspace's
externalRefs, and Tella refs get metadata + chapters + transcript excerpt
injected (`formatVideoContext`, agents/tella/api.ts). Every
`session.repo || repoForPath(worktreeDir)` site is scratch-guarded
(repoForPath throws on non-repo paths).

Round 2 (dddfa657 + fcf1c1a9, same day): NewSession palette has a
"Scratch — no repo" option; SessionControl/HTTP/MCP creates support scratch;
scratch breadcrumb shows the feed tile; sidebar files repo-less feed
workspaces under their feed kind; deleteWorkspace removes the scratch dir +
once-per-boot orphan sweep (14d grace). **MCP least privilege**: descriptors
declare `mcpServers` (tella → ["tella"]); feed-workspace sessions get that
as their allowlist at every create path, at prompt time (covers pre-existing
files), and on the opening run — a video chat sees NO external MCP servers
until a "tella" server exists in mcp-config (unknown names are skipped;
empty-list can't express "none", run-session normalizes it to "all").
Context injection likewise fires on the FIRST prompt of prompt-less creates
(tab-strip "+" siblings) via externalRefsOpeningContext (feeds.ts).

Still open: Tella MCP mount (OAuth 2.1 — needs an interactive browser flow);
tella-fusion PR #5332 (frame-ancestors carve-out for /video/:id/view+edit;
once merged+deployed, switch FeedWebPane's refWebPanel to prefer the edit
page over the embed — note Safari/3p-cookie caveat in the PR); scoped
sessions run on per-session opencode servers (allowlist ⇒ not
shared-pool-eligible) — acceptable, same as automations.

## Full build-out (standing goal, 2026-07-28)

"Make it easy to connect any MCP (sign in per user too), and easy to create
projects like plain/tella and link MCPs to them; custom code per project via
plugins." Workstreams:

- **W1 — MCP connect UX (LANDED)**: browser OAuth 2.1+PKCE flow run by
  OpenSession itself (src/server/mcp-oauth.ts): RFC 9728/8414 discovery,
  dynamic client registration, redirect to
  `<publicBaseUrl>/backstage/api/connections/mcp-oauth/callback`, Connect
  buttons on Connections cards (workspace-wide or "my account"). Replaces the
  unusable headless CLI flow (opencode's loopback listener).
- **W1b — feeds ride the MCP (LANDED)**: the sidebar band and the
  opening-prompt video context call the Tella MCP's list_videos/get_video
  tools server-side (src/server/mcp-client.ts) on the REQUESTING USER's
  grant (workspace fallback) — per-viewer feeds, per-user 60s cache. The
  REST client + TELLA_API_KEY are retired. Proof session (bks-019fac65…):
  exactly one external server visible, get_video + list_videos called
  successfully on the requesting user's grant.
- **W2b — fresh-auth MCP relay (LANDED c79a70ba)**: AuthKit access tokens
  live ~5 min; static header injection 401'd mid-turn (bks-019fac84 — the
  agent hand-rolled an MCP client and read the token store in response).
  OAuth-granted servers now route via /relay/<server>?t=… on the loopback
  MCP-HTTP listener: fresh Authorization per REQUEST (creator-first),
  streamable-HTTP passthrough, tokens never in engine config, config hash
  stable across rotation, relay tokens persisted for detached servers.
- **W2 — per-user MCP auth (LANDED)**: grants stored per server in
  `~/.opensession-mcp-oauth.json` — one `shared` + per-user keyed by
  canonical team name. Injection at run time in withDynamicCredentials():
  the run user's own grant wins, else shared; engines only ever see access
  tokens (refresh handled here: lazy kick + 2-min ticker). Automations pass
  no user ⇒ shared grant only, fail-closed like allowedUsers. Caveat: token
  rotation changes the per-run config hash ⇒ shared-server drain-respawn,
  same as GitHub user tokens.
- **Sharing/identity decisions (decided 2026-07-29, landed 869c0c36)**:
  sessions have no per-session auth (whole team can open/prompt). MCP grant
  identity per run: session CREATOR first → prompter's own grant → workspace
  grant, so a shared session reads the same objects for everyone
  (RunAgentOpts.mcpGrantUser; TODO: sandboxed-run path doesn't thread it).
  allowedUsers visibility passes when prompter OR creator is cleared
  ("anyone with access to the session"); per-session invite lists are the
  future refinement. Feed-workspace context teaches `BACKSTAGE_VIDEO:
  /abs/path` (jsonl-parser VIDEO_MARKER) so cut clips render inline.
- **W3 — projects/feeds as config (BACKEND LANDED d0df39c6)**: ConfigFeed in
  ~/.opensession-feeds.json (MCP server + list tool + dot-path map + {id}
  panel template), registry overlay per read (edit without restart), generic
  adapter on the viewer's grant, CRUD POST/DELETE /api/feeds, tool catalog
  GET /api/connections/mcp/:name/tools. Panels are descriptor-driven
  frontend-wide (lib/feeds-meta.ts; tella hardcode = cold-cache fallback
  only). PROVEN: "Playlists" project created purely from config (wrong path
  guess fixed by config re-POST — list_playlists returns `channels`).
  UI LANDED 1d272215: Connections → Projects section + New-project modal
  (server picker → live tool catalog → Fetch-sample mapping suggester →
  panel template → Create; config feeds deletable). W3 COMPLETE.: a "New project" flow that takes
  name/icon/refKind + linked MCP servers + an items source (REST endpoint or
  an MCP list-tool + field mapping) + a web-panel URL template, stored in
  `~/.opensession-feeds.json`; the feeds registry loads config feeds beside
  code feeds. This is the "any MCP/API is a project" payoff — Tella stays
  the code-feed reference, new ones need zero core changes.
- **W4 — plugins for custom code (LANDED)**: AgentModule is the plugin seam
  — optional `getFeed()` beside getRoutes/startup/shutdown/health, with the
  five-surface contract documented on the interface (src/agents/types.ts).
  ensureFeedsRegistered pulls feeds from loaded modules; src/agents/tella is
  the reference plugin (TellaAgent, self-gating, loaded unconditionally in
  loadAgents). Config feeds (W3) cover no-code; a module is for bespoke
  fetching/webhooks/background work. `@opensession/feed-*` extraction stays
  mechanical because the interface is the boundary.
- **W6 — per-feed filters (LANDED 577aac51)**: FeedFilterSpec on
  descriptors — arg-mode (values passed to the list tool; options resolvable
  from sibling MCP tools on the viewer's grant: tella tagIds via list_tags,
  playlistId via list_playlists) and meta-mode (client-side over item.meta,
  options derived from items: plain assignee incl. Me/Unassigned, labels).
  Built-ins per band: Linked session + Sort (non-lane feeds). Selections
  persist per browser/feed; arg changes refetch (server cache keys
  user+args). Plain's bespoke filter menu retired onto this; search honors
  descriptor searchMeta. Config feeds can declare filters in
  ~/.opensession-feeds.json (same spec). Also fixed: repo-less feed
  workspaces no longer mint a pseudo-repo band (duplicate "tella"), and
  repo-less rows drop the PR glyph.
- **W5 — CUTOVER LANDED ef919ee3 (2026-07-29)**: Plain rides the generic
  feed band. PlainAgent.getFeed() (lanes, attentionLane, meta = full
  SupportThreadSummary); sidebar derives supportThreads from feed items (own
  fetch loop deleted); generic band = container/header/badge/lanes, plain
  rows still the bespoke SupportRow pipeline; flat view keeps lanes inline;
  mark-done busts the feed cache; renderPlainProject deleted. Verified by
  screenshot (band + Urgent lane + filter pixel-faithful). REMAINING POLISH
  (not blocking): step 3's panel-kind registry rename (the conversation tab
  still rides plainThreadId — works; the "video" ActiveViewTab key is
  internal naming only), and step 5 after-checks in daily use (Tinder,
  SupportPreview, triage redirect — routes untouched). Original plan below
  for reference. Execution
  plan (atomic cutover — a registered plain feed + the legacy band would
  render TWICE, so these land in ONE commit after the generic band grows the
  missing capabilities):
  1. Generic band capabilities in Sidebar.tsx: descriptor-driven LANES
     (FeedLane[] grouping + collapsed-band attention badge), row ACTIONS
     (pin via the existing `support:`-style pin keys → generalize to
     `feed:<refKind>:<id>`; a per-feed "complete" action → new optional
     descriptor field `actions: [{key,label,icon}]` POSTing to
     /api/feeds/:id/items/:itemId/action → provider callback), and the
     per-feed filter menu (assignee/label from item.meta) — port
     SupportFilterState generically.
  2. PlainAgent.getFeed(): SupportThreadSummary → FeedItem (lane =
     priority, meta = {labels, assignee, customer}), lanes = the
     SUPPORT_PRIORITY_GROUPS taxonomy, mcpServers ["plain"], action
     mark-done → setThreadStatus. Feed items poll listTodoThreads (the 30s
     cache moves into the provider).
  3. Panel kind registry: descriptor gains `panelKind?: "web" |
     "conversation"`; the view-tab producer in App.tsx goes generic
     (iterate refs → panel meta → ViewTab with the feed's label), replacing
     BOTH the `"video"` ActiveViewTab literal and the plainThreadId-driven
     conversation tab; ConversationPane binds to `{kind:"plain"}` refs.
     Route slug becomes /workspace/:id/panel/<refKind> with 301s from
     /video + /conversation.
  4. Cutover commit: register plain feed, delete renderPlainProject +
     renderSupportLanes + the splice; keep plainThreadId reads/writes
     (compat) and ALL 13 /api/plain/* mutation routes.
  5. After-checks: Support Tinder + SupportPreview deep links, plain-triage
     redirect, plainThreadId workspace resolve (stays keyed plain-<id>;
     ExternalRef {kind:"plain"} stamped ADDITIONALLY), archive sweep.
  Risk notes: Sidebar.tsx is a sweep magnet (stage with git add -p);
  the Plain band is the team's daily support surface — cutover behind a
  quick visual check (headless screenshot recipe in memory).

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
