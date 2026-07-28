# Instance configuration

OpenSession application code has portable defaults. Team-specific repositories,
identity, domains, policy, integrations, and routines belong in
`~/.opensession/config.json`; use
[`config.example.json`](../config.example.json) as the schema and starting
point.

## Portability boundaries

- `repos` is authoritative when present. Repository behavior such as dependency
  installation, preview startup, warm-cache markers, AWS profile names,
  deployment tracking, and security-scan guidance lives on each repo entry.
- `identity.team` owns commit attribution, GitHub/Slack/Linear mappings,
  per-user connector access, and the team web-sign-in allowlist. There is no
  built-in company roster. `identity.defaultTimezone` controls the fallback
  used for team-local scheduling and defaults to `UTC`.
- `branding` and `persona` are injected into the frontend and prompt builders.
  The frontend bootstrap also receives the public base URL, default repo id,
  and configured GitHub bot logins.
- Integrations are off unless `integrations.<name>.enabled` is true (or an
  explicit enable/disable environment variable is set). Integration-specific
  values such as OAuth callbacks, GitHub/Plain mention handles, Slack
  workspace metadata, and Linear team keys live in the same section.
- Company routines are data. `integrations.seeds.actions` and
  `integrations.seeds.automations` create records only when
  `integrations.seeds.enabled` is true. Existing persisted records are never
  deleted when seeds are disabled.

Client distributions have their own packaging configuration:

- Chrome: `os1-chrome/deployment.json`
- Electron: `os1-mac/package.json` → `opensession.defaultServer`
- Swift: `OS1DefaultServerURL` in `os1-ios/project.yml`

Bundle identifiers, signing teams, provisioning profiles, update feeds,
entitlements, deployment scripts, and infrastructure log destinations are
distribution/deployment metadata. A downstream distributor should replace
those files without changing application behavior.

## Compatibility literals

Several old names are protocol or persisted-data compatibility, not instance
branding. Do not rename the `bks-`/`prj-` id prefixes,
`===MICHAEL-SUMMARY===`, `BACKSTAGE_VIDEO:`, legacy `michael-*` MCP aliases,
old environment aliases, or old state-directory fallbacks. Running and
historical sessions depend on them.
