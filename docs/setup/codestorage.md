# code.storage

[code.storage](https://code.storage/docs) (Pierre Computer Company's git
host) can back a repo as an alternative to GitHub. It has no pull requests,
reviews, checks, or user accounts — the review model is a branch compared
against the default branch (branch-diff API) and merged via the merge API.
Support is additive and config-gated: nothing loads or runs until the
integration below is configured, and GitHub repos are untouched either way.

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

**From the UI (no config-file editing):** Settings → Connections → the
"Code Storage" card. Enter the org identifier, paste the PKCS8 PEM private
key, and Connect — the key is written to `~/.opensession/codestorage.pem`
(mode 0600), `integrations.codestorage` is persisted, a webhook secret is
generated, and the connection is validated with a live repo-list call
(`POST /api/setup/codestorage/connect`). The card then shows the webhook
receiver info (path, secret, last delivery) and a Disconnect button
(`POST /api/setup/codestorage/disconnect` — removes the config, leaves the
key file). `GET /api/setup/codestorage/status` backs the card.

Or by hand, in `~/.opensession/config.json`:

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
- The `codeStorage` (camelCase) spelling is accepted too.

No environment variables are involved; config presence is the whole gate.

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

Beyond editing config by hand, three registration paths know code.storage:

- `GET /api/setup/codestorage/repos` — the org's repos (same response shape
  as `/api/setup/github/repos`, so the setup wizard renders either host).
- `POST /api/setup/repos` with `{"source": "codestorage", "repoId":
  "acme/widget"}` — resolves the repo via the REST API, clones it (JWT-authed),
  registers it with `host`/`csRepo` set, and wires the credential helper.

In every path the persisted remote is the **credential-free** URL — auth comes
from the URL-scoped credential helper, which mints a fresh JWT per fetch/push.
On boot, existing checkouts of `host: "codestorage"` repos get the helper
wired idempotently, so hand-registered checkouts work too.

## What works, what doesn't

Supported — sessions on a code.storage repo behave like GitHub sessions except
where PRs themselves are the feature:

- **Push/pull** from session worktrees (credential helper mints the JWT).
- **Branch-based reviews**: the Changes tab shows the branch's diff against
  the default branch (the branch-diff API — every change is reviewable before
  merge), commits, and conflict preview.
- **Merge** from the review UI via the merge API (humans merge; agents never
  do). The source branch is always deleted after a successful merge — on this
  host the branch IS the change request, so a surviving branch would re-list
  as an open change.
- **Review comments and reviews**, backed by git notes: each comment is one
  branch-tagged JSON line appended to a note on the branch's tip commit
  (dedicated `opensession-comments` notes ref), and the conversation
  aggregates the ref's notes by branch tag — so comments survive force-pushes
  and merge-base advances. A review is a comment with a verdict
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
`POST /codestorage/webhook` on Public ingress (port 3860 behind Funnel,
Cloudflare Tunnel, or Caddy, alongside `/github/webhook`). The HMAC secret
(`integrations.codestorage.webhookSecret`) is generated automatically on the
first connect/status call and shown (with copy/reveal) on the Connections
card — paste it into the Pierre dashboard → Webhooks. Deliveries are
HMAC-verified (`X-Pierre-Signature`, 5-minute replay tolerance) and rejected
until the secret is configured. A `push` drops the cached branch-review state
for the pushed branch (and broadcasts `pr_updated` to open tabs) so the UI
re-reads code.storage immediately instead of waiting out polling TTLs;
`repo.sync.failed` records a per-repo warning surfaced on the card until the
next `repo.sync.succeeded`. The card also shows last-delivery metadata
(event, time, invalid-signature warnings) from the status endpoint.

## Comments (git notes)

code.storage has no comment or review-thread model, but it supports [git
notes](https://code.storage/docs/guides/git-notes.md): text attached to a
commit without changing the commit or the tree, readable and writable through
the notes REST API under isolated ref namespaces (`refs/notes/<ref>`). That is
the natural place for review commentary on this host — a note on the branch
head travels with the repo itself (no side database), needs only the same
per-repo JWT (`git:write` to write, `git:read` to read), and stays invisible
to normal clones unless the notes ref is fetched explicitly. Keep Open
Session's notes under a dedicated ref (an `opensession/…` namespace) so they
never collide with other systems' note streams (CI status, agent traces).

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
- Registration paths treat a pasted `…+ephemeral.git` URL as the base repo
  (`parseCsRemote` strips the suffix), so you can't register a broken
  `<repoId>+ephemeral` entry by accident.

## Pieces (for developers)

- `packages/core/opensession-server/src/server/codestorage/auth.ts` — JWT minting (WebCrypto), remote URLs.
- `packages/core/opensession-server/src/server/codestorage/client.ts` — REST client: repos, branches, merge +
  preview, commits, diffs (branch diff = the PR-diff equivalent), files, git
  notes (write/read/delete/list-refs).
- `packages/core/opensession-server/src/server/codestorage/remote.ts` — `parseCsRemote` (incl. `+ephemeral`
  remotes), per-checkout
  credential-helper wiring (URL-scoped, never touches github.com flows),
  registration clones (`cloneCsCheckout`) and boot adoption
  (`adoptCsCheckouts`).
- `packages/core/opensession-server/src/server/codestorage/webhook.ts` — `POST /codestorage/webhook` (HMAC
  verification, push → PR-cache invalidation + `pr_updated` broadcast,
  sync-failure warnings, last-delivery metadata).
- `packages/core/opensession-server/src/server/routes/setup-codestorage.ts` — the UI connect flow
  (`/api/setup/codestorage/{connect,status,disconnect}`).
- `scripts/cs-credential.ts` — the git credential helper itself.
