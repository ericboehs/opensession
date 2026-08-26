# code.storage

[code.storage](https://code.storage/docs) (Pierre Computer Company's git
host) can back a repo as an alternative to GitHub. It has no pull requests,
reviews, checks, or user accounts — the review model is a branch compared
against the default branch (branch-diff API) and merged via the merge API.
Support is additive and credential-gated: code.storage operations stay inert
until an org and private key path are configured, and GitHub repos are
untouched. Boot-time webhook registration has the separate enable gate
described below.

## Creating the org and signing key

In the [Pierre dashboard](https://code.storage):

1. Create (or pick) your **organization** — its identifier is the
   `<org>.code.storage` subdomain and the JWT `iss` claim below.
2. Generate a keypair and register the **public key** with the org (the
   dashboard's key management page). ES256 (P-256) and RS256 are both
   accepted; e.g.

   ```sh
   openssl ecparam -genkey -name prime256v1 -noout \
     | openssl pkcs8 -topk8 -nocrypt -out codestorage-key.pem
   openssl ec -in codestorage-key.pem -pubout   # register this output
   ```

3. Keep the **PKCS8 PEM private key** on the instance (it never leaves the
   box) — its path goes in the config block below.

There are no user accounts, seats, or bot users to create: identity is
whatever `sub` your instance puts in the JWTs it signs, so the whole
integration is one org + one key.

## How auth works

There is no OAuth or PAT. You register a public key with code.storage (Pierre
Admin Panel) and keep the matching **PKCS8 PEM private key** on the instance;
Open Session signs short-lived JWTs with it locally (ES256/P-256 or RS256,
auto-detected). Git speaks HTTPS with username literally `t` and a JWT as the
password; checkouts get a URL-scoped git credential helper that mints a fresh
token per fetch/push, so no long-lived secret is ever written to git config.

## Configure

**From the UI (no config-file editing):** Settings → Integrations →
code.storage. Enter the org identifier, paste the PKCS8 PEM private key, and
Connect. The key is written beside the active config file as
`codestorage.pem`, normally `~/.opensession/codestorage.pem`, with mode 0600.
The flow persists the integration, generates a webhook secret, and validates
it with a live repo-list call (`POST /api/setup/codestorage/connect`). The
integration dialog then shows webhook receiver information and a Disconnect
button (`POST /api/setup/codestorage/disconnect`, which removes the config but
leaves the key file). `GET /api/setup/codestorage/status` backs the dialog.

Or edit the active config file, normally `~/.opensession/config.json`:

```json
{
  "integrations": {
    "codestorage": {
      "enabled": true,
      "org": "acme",
      "privateKeyPath": "/srv/opensession/secrets/codestorage-key.pem",
      "apiBase": "https://api.acme.code.storage/api"
    }
  }
}
```

- `org` — your organization identifier: the `<org>.code.storage` remote
  subdomain and the JWT `iss` claim.
- `privateKeyPath` — the PKCS8 PEM signing key. Keep it readable by the
  service user only.
- `apiBase` — optional; defaults to `https://api.<org>.code.storage/api`.

Use lowercase `integrations.codestorage` with `enabled: true` for boot-time
integration and webhook registration. If `ENABLE_CODESTORAGE` is set, it
overrides that flag; only the literal value `true` enables the integration.
Credential readers also accept `integrations.codeStorage` for org and key
values, but that section's `enabled` field does not activate the integration
loader. Credentials are not read from environment variables.

Then mark repos as code.storage-hosted:

```json
{
  "repos": {
    "widget": {
      "repo": "/srv/repos/widget",
      "defaultBranch": "main",
      "host": "codestorage",
      "csRepo": "acme/widget"
    }
  }
}
```

- `host` — `"codestorage"`; absent or `"github"` keeps the normal GitHub
  behavior.
- `csRepo` — the code.storage repo id/path (what the JWT `repo` claim and the
  remote URL use), not a GitHub `owner/name`.

## Registering repos

Beyond editing config by hand:

- The Repositories UI gets up to 300 org repos from
  `GET /api/setup/codestorage/repos`. It clones a selection with
  `POST /api/setup/repos` using `source: "codestorage"` and its repo id.
- The UI's Local folder option, or the same POST endpoint with
  `{"source": "local", "path": "/absolute/path"}`, registers an existing
  checkout after inspecting its origin.
- `opensession repos add /absolute/path` registers an existing checkout from
  the CLI.

There is no code.storage remote-URL paste input. Repositories outside the
300-item picker window can still be registered directly with
`POST /api/setup/repos` using `source: "codestorage"` and `repoId`.

Server-side code.storage clones persist a credential-free origin and use the
URL-scoped helper to mint a fresh JWT per fetch or push. Existing local,
CLI-registered, or hand-configured checkouts also receive the helper, either
at registration or on boot, but their origin is not rewritten. If an origin
already embeds a JWT, normalize it yourself, for example:

```sh
git -C /srv/repos/widget remote set-url origin \
  https://acme.code.storage/acme/widget.git
```

## What works, what doesn't

Supported — sessions on a code.storage repo behave like GitHub sessions except
where PRs themselves are the feature:

- **Push/pull** from session worktrees (credential helper mints the JWT).
- **Branch-based reviews**: the Changes tab shows the branch's diff against
  the default branch (the branch-diff API — every change is reviewable before
  merge), commits, and conflict preview.
- **Merge** from the review UI via the merge API (humans merge; agents never
  do). After a successful merge, Open Session attempts to delete the source
  branch. Deletion is best-effort; fully merged or empty-diff survivors are
  omitted from the open review list.
- **Review comments and reviews**, backed by git notes: each comment is one
  branch-tagged JSON line appended to a note on the branch's tip commit in
  `refs/notes/opensession-comments`. The conversation aggregates notes by
  branch tag, so comments survive force-pushes and merge-base advances,
  subject to a reader cap of 500 annotated commits per repository. Comments
  beyond that cap may stop appearing. A review is a comment with a verdict
  prefix (`APPROVE`/`REQUEST_CHANGES`) — purely conversational, nothing on
  the host gates merges on it. Inline comments keep their `path:line` anchor
  as a prefix; threading is flat.
- **Notes on commits**: the review UI's commits tab shows git notes from the
  common namespaces (`commits`, `reviews`, `ci`) under each commit.
- Agent prompts adapt: sessions are told to push their branch — "a pushed
  branch IS the change request" — instead of `gh pr create`.

Not supported, because the concepts don't exist upstream (no PR model):

- Checks/CI status — code.storage runs no checks.
- Requested reviewers / reviewer lists; approvals never gate a merge.
- Per-file viewed state tied to a PR.
- Stacked PRs / `gh stack`.
- The `gh` CLI in general — it only speaks GitHub.

## Webhooks

Point a code.storage webhook subscription (push + repo.sync events) at
`POST /codestorage/webhook` on public ingress (`127.0.0.1:3860` by default),
behind Funnel, Cloudflare Tunnel, or Caddy and alongside `/github/webhook`.
The HMAC secret
(`integrations.codestorage.webhookSecret`) is generated automatically on the
first connect/status call and shown (with copy/reveal) in the code.storage
integration dialog. Paste it into the Pierre dashboard → Webhooks. Deliveries
are HMAC-verified (`X-Pierre-Signature`, 5-minute replay tolerance) and
rejected until the secret is configured. A `push` drops the cached
branch-review state for the pushed branch and broadcasts `pr_updated` to open
tabs so the UI re-reads code.storage without waiting out polling TTLs.

Webhook delivery metadata, rejection counts, and sync warnings are
process-local. A `repo.sync.failed` event records a per-repo warning, a
`repo.sync.succeeded` event clears that repo's warning, and a server restart
clears all recorded webhook health state.

## Comments (git notes)

code.storage has no comment or review-thread model, but it supports [git
notes](https://code.storage/docs/guides/git-notes.md): text attached to a
commit without changing the commit or the tree, readable and writable through
the notes REST API under isolated ref namespaces (`refs/notes/<ref>`). That is
the natural place for review commentary on this host — a note on the branch
head travels with the repo itself (no side database), needs only the same
per-repo JWT (`git:write` to write, `git:read` to read), and stays invisible
to normal clones unless the notes ref is fetched explicitly. Open Session
stores review comments in the dedicated `refs/notes/opensession-comments`
ref, separate from common note streams such as CI status and agent traces.

## Ephemeral branches

[Ephemeral branches](https://code.storage/docs/guides/ephemeral-branches.md)
are a disposable ref namespace on the same repository — previews, CI
artifacts, experiments — reached by inserting `+ephemeral` before `.git` in
the remote URL. On a registered checkout this just works, because the
credential helper's scope is host-wide and it mints the JWT for the base repo
(the `+ephemeral` suffix selects a ref namespace, not a different repository):

```sh
git remote add ephemeral https://acme.code.storage/acme/widget+ephemeral.git
git push ephemeral my-preview
git pull ephemeral my-preview
```

Promotion (ephemeral → real) is plain git — fetch the ephemeral ref, push it
to origin:

```sh
git fetch ephemeral my-preview:my-preview
git push origin my-preview
```

Notes:

- Ephemeral branches are fully isolated from normal branches until promoted,
  and (on GitHub-synced repos) never mirror to GitHub.
- We deliberately do **not** surface ephemeral branches in the review list —
  on this host a branch IS a change request, and ephemeral refs are exactly
  the branches that aren't one yet.
- A pasted remote URL is not a registration input. When an existing
  checkout's origin ends in `+ephemeral.git`, origin inspection stores the
  base repo id.

## Pieces (for developers)

- `packages/core/opensession-server/src/server/codestorage/auth.ts` — JWT minting (WebCrypto), remote URLs.
- `packages/core/opensession-server/src/server/codestorage/client.ts` — REST client: repos, branches, merge +
  preview, commits, diffs (branch diff = the PR-diff equivalent), files, git
  notes (write/read/delete/list-refs).
- `packages/core/opensession-server/src/server/codestorage/pr-host.ts` — branch-to-review adapter: details,
  diffs, comments and reviews, merge/close behavior, commit notes, and caches.
- `packages/core/opensession-server/src/server/codestorage/integration.ts` — boot-time integration module that
  registers the webhook route.
- `packages/core/opensession-server/src/server/codestorage/remote.ts` — `parseCsRemote` (incl. `+ephemeral`
  remotes), per-checkout
  credential-helper wiring (URL-scoped, never touches github.com flows),
  registration clones (`cloneCsCheckout`) and boot adoption
  (`adoptCsCheckouts`).
- `packages/core/opensession-server/src/server/codestorage/webhook.ts` — webhook handling: HMAC verification,
  push → PR-cache invalidation + `pr_updated` broadcast, sync-failure warnings,
  and process-local delivery metadata.
- `packages/core/opensession-server/src/server/routes/setup-codestorage.ts` — the UI connect flow
  (`/api/setup/codestorage/{connect,status,disconnect}`).
- `scripts/cs-credential.ts` — the git credential helper itself.
