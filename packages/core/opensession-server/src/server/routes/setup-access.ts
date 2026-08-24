/** Settings → Setup → Server access.
 *
 * Saves the private app origin and optional public webhook origin to both the
 * typed config and the service environment file. The parent setup handler owns
 * workspace-admin authorization before delegating here.
 */

import { audit } from "../audit";
import {
  normalizeAppOrigin,
  normalizeWebhookOrigin,
  setupAccessSnapshot,
} from "../setup-access";
import type { RouteContext } from "./context";

export async function handleSetupAccessRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path !== "/api/setup/access" || req.method !== "PUT") return undefined;

  const body = (await req.json().catch(() => null)) as {
    publicBaseUrl?: unknown;
    webhookBaseUrl?: unknown;
  } | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (
    typeof body.publicBaseUrl !== "string" ||
    typeof body.webhookBaseUrl !== "string"
  ) {
    return Response.json(
      { error: "App address and webhook address must be strings" },
      { status: 400 },
    );
  }

  let publicBaseUrl: string;
  let webhookBaseUrl: string;
  try {
    publicBaseUrl = normalizeAppOrigin(body.publicBaseUrl);
    webhookBaseUrl = normalizeWebhookOrigin(body.webhookBaseUrl, publicBaseUrl);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid server address" },
      { status: 400 },
    );
  }

  const { prepareEnvFileEdits } = await import("../env-file-edit");
  const { rawConfig, persistRawConfig, withConfigMutationLock } =
    await import("../config-mutation");

  return withConfigMutationLock(async () => {
    // Parse and prepare both stores before either is changed. If the second
    // atomic write fails, restore the first so a failed request is a no-op.
    const config = rawConfig();
    const server =
      config.server &&
      typeof config.server === "object" &&
      !Array.isArray(config.server)
        ? (config.server as Record<string, unknown>)
        : {};
    config.server = server;
    server.publicBaseUrl = publicBaseUrl;
    if (webhookBaseUrl) server.webhookBaseUrl = webhookBaseUrl;
    else delete server.webhookBaseUrl;
    const envEdit = prepareEnvFileEdits({
      OPENSESSION_UI_BASE: publicBaseUrl,
      OPENSESSION_WEBHOOK_BASE: webhookBaseUrl,
    });

    envEdit.commit();
    try {
      persistRawConfig(config);
    } catch (error) {
      envEdit.rollback();
      throw error;
    }

    audit({
      kind: "setup_access_update",
      fields: ["publicBaseUrl", "webhookBaseUrl"],
      separateWebhookOrigin: Boolean(webhookBaseUrl),
    });

    return Response.json({
      access: setupAccessSnapshot({
        publicBaseUrl,
        webhookBaseUrl: webhookBaseUrl || null,
      }),
      // Both origins feed boot-time server and frontend constants. The file
      // writes are complete, but this process still holds the old values.
      restartRequired: true,
    });
  });
}
