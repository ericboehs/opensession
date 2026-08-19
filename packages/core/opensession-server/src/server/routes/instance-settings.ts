/**
 * Instance-settings routes: the writable slice of ~/.opensession/config.json
 * exposed in Settings → General and Settings → Identity.
 * Config reads are mtime-guarded per call, so a write applies to new runs
 * immediately; the frontend rebuild re-injects the instance blob + HTML
 * titles and nudges open tabs via the `frontend_updated` broadcast.
 */

import type { RouteContext } from "./context";
import {
	configPath,
	organizationName,
	personaName,
	productName,
	productMark,
} from "../config";
import {
	persistRawConfig,
	rawConfig,
	withConfigMutationLock,
} from "../config-mutation";
import { scheduleFrontendRebuild } from "../frontend-build";
import {
	OrganizationIconError,
	MAX_ORGANIZATION_ICON_BYTES,
	organizationIconRevision,
	removeOrganizationIcon,
	saveOrganizationIcon,
} from "../organization-settings";
import { requireWorkspaceAdmin } from "../workspace-auth";

const MAX_NAME_LENGTH = 80;

class OrganizationIconBodyTooLarge extends Error {}

async function organizationIconBody(req: Request): Promise<Uint8Array> {
	const contentLength = Number(req.headers.get("content-length"));
	if (Number.isFinite(contentLength) && contentLength > MAX_ORGANIZATION_ICON_BYTES) {
		throw new OrganizationIconBodyTooLarge();
	}
	const reader = req.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > MAX_ORGANIZATION_ICON_BYTES) {
			await reader.cancel();
			throw new OrganizationIconBodyTooLarge();
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return bytes;
}

function identityDto() {
	return {
		personaName: personaName(),
		productName: productName(),
		productMark: productMark(),
		configPath: configPath(),
	};
}

function generalDto(publicPrefix: string) {
	const revision = organizationIconRevision();
	return {
		organizationName: organizationName(),
		organizationIconUrl:
			revision === null
				? null
				: `${publicPrefix}/organization-icon.png?v=${revision}`,
		organizationIconRevision: revision,
		configPath: configPath(),
	};
}

/** Optional string field: absent → undefined, otherwise a length-capped string. */
function nameField(v: unknown, label: string): string | undefined {
	if (v === undefined) return undefined;
	if (typeof v !== "string") throw new Error(`${label} must be a string`);
	if (v.trim().length > MAX_NAME_LENGTH) {
		throw new Error(`${label} must be at most ${MAX_NAME_LENGTH} characters`);
	}
	return v;
}

function setOrDelete(
	config: Record<string, unknown>,
	section: string,
	key: string,
	value: string | undefined,
): void {
	if (value === undefined) return;
	const current =
		config[section] &&
		typeof config[section] === "object" &&
		!Array.isArray(config[section])
			? { ...(config[section] as Record<string, unknown>) }
			: {};
	const trimmed = value.trim();
	if (trimmed) current[key] = trimmed;
	else delete current[key];
	if (Object.keys(current).length) config[section] = current;
	else delete config[section];
}

export async function handleInstanceSettingsRoutes(
	ctx: RouteContext,
): Promise<Response | undefined> {
	const { req, path, publicPrefix } = ctx;

	if (path === "/api/settings/general" && req.method === "GET") {
		return Response.json(generalDto(publicPrefix));
	}

	if (path === "/api/settings/general" && req.method === "PUT") {
		const forbidden = requireWorkspaceAdmin(ctx);
		if (forbidden) return forbidden;
		const body = (await req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!body) {
			return Response.json({ error: "expected a JSON body" }, { status: 400 });
		}
		try {
			const name = nameField(body.organizationName, "organizationName");
			await withConfigMutationLock(async () => {
				const config = rawConfig();
				setOrDelete(config, "organization", "name", name);
				persistRawConfig(config);
			});
		} catch (error: any) {
			return Response.json(
				{ error: error?.message || String(error) },
				{ status: 400 },
			);
		}
		return Response.json(generalDto(publicPrefix));
	}

	if (path === "/api/settings/general/icon" && req.method === "POST") {
		const forbidden = requireWorkspaceAdmin(ctx);
		if (forbidden) return forbidden;
		try {
			saveOrganizationIcon(await organizationIconBody(req));
			return Response.json(generalDto(publicPrefix));
		} catch (error) {
			if (error instanceof OrganizationIconBodyTooLarge) {
				return Response.json(
					{ error: "That image is too large. Icons cap at 4 MB." },
					{ status: 413 },
				);
			}
			return Response.json(
				{
					error:
						error instanceof OrganizationIconError
							? error.message
							: "Couldn’t store that icon",
				},
				{ status: error instanceof OrganizationIconError ? 400 : 500 },
			);
		}
	}

	if (path === "/api/settings/general/icon" && req.method === "DELETE") {
		const forbidden = requireWorkspaceAdmin(ctx);
		if (forbidden) return forbidden;
		removeOrganizationIcon();
		return Response.json(generalDto(publicPrefix));
	}

	if (path === "/api/settings/identity" && req.method === "GET") {
		return Response.json(identityDto());
	}

	if (path === "/api/settings/identity" && req.method === "PUT") {
		const forbidden = requireWorkspaceAdmin(ctx);
		if (forbidden) return forbidden;
		const body = (await req.json().catch(() => null)) as Record<
			string,
			unknown
		> | null;
		if (!body) {
			return Response.json({ error: "expected a JSON body" }, { status: 400 });
		}
		try {
			const patch = {
				personaName: nameField(body.personaName, "personaName"),
				productName: nameField(body.productName, "productName"),
				productMark: nameField(body.productMark, "productMark"),
			};
			await withConfigMutationLock(async () => {
				const config = rawConfig();
				setOrDelete(config, "persona", "name", patch.personaName);
				setOrDelete(config, "branding", "productName", patch.productName);
				setOrDelete(config, "branding", "productMark", patch.productMark);
				persistRawConfig(config);
			});
		} catch (e: any) {
			return Response.json({ error: e?.message || String(e) }, { status: 400 });
		}
		scheduleFrontendRebuild("identity settings");
		return Response.json(identityDto());
	}

	return undefined;
}
