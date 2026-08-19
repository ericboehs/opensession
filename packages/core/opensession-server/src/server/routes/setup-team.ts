/**
 * Team roster CRUD for the web setup page — mutates `identity.team` in
 * config.json. Part of the /api/setup family (dispatched from setup.ts).
 *
 * Raw entries are edited in place with unknown keys preserved; every
 * candidate member must pass parseTeamMember (the config loader's own rules)
 * before it is written, so the roster can never gain an entry the loader
 * would drop. All writes serialize under the shared config mutation lock.
 */

import { audit } from "../audit";
import { parseTeamMember, type TeamMember } from "../config";
import {
  persistRawConfig,
  rawConfig,
  withConfigMutationLock,
} from "../config-mutation";
import { validateEnvValue } from "../env-file-edit";
import type { RouteContext } from "./context";

const STRING_FIELDS = ["name", "email", "slackId", "github", "timezone"] as const;
const STRING_ARRAY_FIELDS = ["aliases", "linearEmails"] as const;
const BOOLEAN_FIELDS = ["githubToSlack", "directory"] as const;

type MemberPatch = Record<string, unknown>;

/** Validate one request body field; returns an error string or null. A field
 *  not present in the body is untouched. `null` means "delete the field"
 *  (PUT-merge only; `name` can never be deleted). */
function validateMemberFields(
  body: Record<string, unknown>,
  allowNullDeletes: boolean,
): string | null {
  for (const field of STRING_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null && allowNullDeletes && field !== "name") continue;
    const err = validateEnvValue(value);
    if (err) return `${field}: ${err}`;
  }
  for (const field of STRING_ARRAY_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null && allowNullDeletes) continue;
    if (!Array.isArray(value)) return `${field}: must be an array of strings`;
    for (const item of value) {
      const err = validateEnvValue(item);
      if (err) return `${field}: ${err}`;
    }
  }
  for (const field of BOOLEAN_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null && allowNullDeletes) continue;
    if (typeof value !== "boolean") return `${field}: must be a boolean`;
  }
  const known = new Set<string>([
    ...STRING_FIELDS,
    ...STRING_ARRAY_FIELDS,
    ...BOOLEAN_FIELDS,
  ]);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) return `unknown field: ${key}`;
  }
  return null;
}

/** The raw `identity.team` array (unknown keys preserved), plus the raw
 *  config it lives in — mutate the array, then persist the config. */
function rawTeam(config: Record<string, unknown>): MemberPatch[] {
  const identity =
    config.identity && typeof config.identity === "object" && !Array.isArray(config.identity)
      ? (config.identity as Record<string, unknown>)
      : {};
  config.identity = identity;
  const team = Array.isArray(identity.team) ? identity.team : [];
  identity.team = team;
  return team.filter(
    (m): m is MemberPatch => !!m && typeof m === "object" && !Array.isArray(m),
  );
}

function memberName(entry: MemberPatch): string {
  return typeof entry.name === "string" ? entry.name.trim().toLowerCase() : "";
}

export async function handleSetupTeamRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;

  if (path === "/api/setup/team" && req.method === "GET") {
    const { configuredIdentity } = await import("../config");
    return Response.json({ members: configuredIdentity().team });
  }

  if (path === "/api/setup/team" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as MemberPatch | null;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const invalid = validateMemberFields(body, false);
    if (invalid) return Response.json({ error: invalid }, { status: 400 });
    const member = parseTeamMember(body);
    if (!member) {
      return Response.json({ error: "name is required" }, { status: 400 });
    }
    return withConfigMutationLock(async () => {
      const config = rawConfig();
      const team = rawTeam(config);
      const key = member.name.trim().toLowerCase();
      if (team.some((m) => memberName(m) === key)) {
        return Response.json(
          { error: `A team member named "${member.name}" already exists` },
          { status: 409 },
        );
      }
      team.push({ ...body, name: member.name });
      (config.identity as Record<string, unknown>).team = team;
      persistRawConfig(config);
      audit({
        kind: "setup_team_update",
        action: "add",
        member: member.name,
        fields: Object.keys(body),
      });
      return Response.json({ member }, { status: 201 });
    });
  }

  const memberMatch = path.match(
    /^\/api\/setup\/team\/([^/]+)(\/remove)?$/,
  );
  if (memberMatch) {
    const targetName = decodeURIComponent(memberMatch[1]).trim().toLowerCase();
    const isRemove = !!memberMatch[2];

    if (isRemove && req.method === "POST") {
      return withConfigMutationLock(async () => {
        const config = rawConfig();
        const team = rawTeam(config);
        const idx = team.findIndex((m) => memberName(m) === targetName);
        if (idx === -1) {
          return Response.json({ error: "Team member not found" }, { status: 404 });
        }
        const removed = team[idx];
        team.splice(idx, 1);
        (config.identity as Record<string, unknown>).team = team;
        persistRawConfig(config);
        audit({
          kind: "setup_team_update",
          action: "remove",
          member: typeof removed.name === "string" ? removed.name : targetName,
        });
        return Response.json({ ok: true });
      });
    }

    if (!isRemove && req.method === "PUT") {
      const body = (await req.json().catch(() => null)) as MemberPatch | null;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }
      const invalid = validateMemberFields(body, true);
      if (invalid) return Response.json({ error: invalid }, { status: 400 });
      return withConfigMutationLock(async () => {
        const config = rawConfig();
        const team = rawTeam(config);
        const idx = team.findIndex((m) => memberName(m) === targetName);
        if (idx === -1) {
          return Response.json({ error: "Team member not found" }, { status: 404 });
        }
        const merged: MemberPatch = { ...team[idx] };
        for (const [key, value] of Object.entries(body)) {
          if (value === null) delete merged[key];
          else merged[key] = value;
        }
        const parsed = parseTeamMember(merged);
        if (!parsed) {
          return Response.json(
            { error: "The merged member is invalid (name is required)" },
            { status: 400 },
          );
        }
        const newKey = parsed.name.trim().toLowerCase();
        if (
          newKey !== targetName &&
          team.some((m, i) => i !== idx && memberName(m) === newKey)
        ) {
          return Response.json(
            { error: `A team member named "${parsed.name}" already exists` },
            { status: 409 },
          );
        }
        team[idx] = merged;
        (config.identity as Record<string, unknown>).team = team;
        persistRawConfig(config);
        audit({
          kind: "setup_team_update",
          action: "update",
          member: parsed.name,
          ...(newKey !== targetName ? { renamedFrom: targetName } : {}),
          fields: Object.keys(body),
        });
        return Response.json({ member: parsed });
      });
    }
  }

  return undefined;
}

/** Exported for reuse by sibling setup modules. */
export type { TeamMember };
