import {
  configureCloudflareTunnel,
  enableTailscaleFunnel,
  installManagedCaddy,
  publicIngressStatus,
  savePrivateAppOrigin,
  savePublicIngress,
  setupPrivateAppDomain,
  verifyPrivateAppDomain,
} from "../ingress-settings";
import { audit } from "../audit";
import { requireWorkspaceAdmin, workspaceAdminAuthorized } from "../workspace-auth";
import type { IngressExposure } from "../config";
import { refreshIndexHtml } from "../frontend-build";
import type { RouteContext } from "./context";

function errorResponse(error: unknown): Response {
  return Response.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 400 },
  );
}

export async function handleIngressRoutes(ctx: RouteContext): Promise<Response | undefined> {
  const { path, req } = ctx;
  if (path === "/api/ingress" && req.method === "GET") {
    return Response.json(await publicIngressStatus(workspaceAdminAuthorized(ctx)));
  }
  if (path === "/api/ingress/app/setup" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      const provider = body?.provider === "cloudflare" || body?.provider === "vercel"
        ? body.provider
        : null;
      if (!provider) throw new Error("Choose Cloudflare DNS or Vercel DNS");
      const appBaseUrl = await setupPrivateAppDomain({
        domain: String(body?.domain || ""),
        provider,
        email: typeof body?.email === "string" ? body.email : undefined,
        apiToken: typeof body?.apiToken === "string" ? body.apiToken : undefined,
        teamId: typeof body?.teamId === "string" ? body.teamId : undefined,
      });
      audit({ kind: "ingress_private_app_managed", publicBaseUrl: appBaseUrl, dnsProvider: provider });
      refreshIndexHtml("private app domain changed");
      return Response.json({
        ...(await publicIngressStatus(true, { appBaseUrl })),
        restartRequired: true,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/app/test" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    try {
      return Response.json(await verifyPrivateAppDomain());
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/app" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      const appBaseUrl = await savePrivateAppOrigin(String(body?.domain || ""));
      audit({ kind: "ingress_private_app_update", publicBaseUrl: appBaseUrl });
      refreshIndexHtml("private app domain changed");
      return Response.json({
        ...(await publicIngressStatus(true, { appBaseUrl })),
        restartRequired: true,
      });
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress" && req.method === "PUT") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return errorResponse("Expected a JSON body");
    try {
      await savePublicIngress({
        publicBaseUrl: String(body.publicBaseUrl || ""),
        exposure: String(body.exposure || "") as IngressExposure,
        cloudflareTunnelId:
          typeof body.cloudflareTunnelId === "string" ? body.cloudflareTunnelId : undefined,
      });
      refreshIndexHtml("public ingress changed");
      return Response.json(await publicIngressStatus(true));
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/tailscale" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    try {
      await enableTailscaleFunnel();
      refreshIndexHtml("public ingress changed");
      return Response.json(await publicIngressStatus(true));
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/cloudflare" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      await configureCloudflareTunnel({
        publicBaseUrl: String(body?.publicBaseUrl || ""),
        tunnelId: String(body?.tunnelId || ""),
        token: typeof body?.token === "string" ? body.token : undefined,
      });
      refreshIndexHtml("public ingress changed");
      return Response.json(await publicIngressStatus(true));
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/custom" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    try {
      await installManagedCaddy(
        String(body?.publicBaseUrl || ""),
        typeof body?.publicIp === "string" ? body.publicIp : undefined,
      );
      refreshIndexHtml("public ingress changed");
      return Response.json(await publicIngressStatus(true));
    } catch (error) {
      return errorResponse(error);
    }
  }
  if (path === "/api/ingress/test" && req.method === "POST") {
    const forbidden = requireWorkspaceAdmin(ctx);
    if (forbidden) return forbidden;
    return Response.json(await publicIngressStatus(true));
  }
  return undefined;
}
