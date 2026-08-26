import {
  registerLiveActivityDevice,
  registerLiveActivityToken,
  unregisterLiveActivityDevice,
} from "../live-activities";
import { requestUser, type RouteContext } from "./context";

export async function handleLiveActivityRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path === "/api/live-activities/device" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const result = await registerLiveActivityDevice({
      deviceId: body?.deviceId,
      pushToStartToken: body?.pushToStartToken,
      user: requestUser(ctx, body?.user),
      login: ctx.authUser?.login,
    });
    return "error" in result
      ? Response.json(result, { status: 400 })
      : Response.json(result);
  }

  if (path === "/api/live-activities/activity" && req.method === "PUT") {
    const body = await req.json().catch(() => null);
    const result = await registerLiveActivityToken({
      deviceId: body?.deviceId,
      activityId: body?.activityId,
      pushToken: body?.pushToken,
      user: requestUser(ctx, body?.user),
      login: ctx.authUser?.login,
    });
    return "error" in result
      ? Response.json(result, { status: 400 })
      : Response.json(result);
  }

  const deviceMatch = path.match(/^\/api\/live-activities\/device\/([^/]+)$/);
  if (deviceMatch && req.method === "DELETE") {
    const body = await req.json().catch(() => null);
    const result = await unregisterLiveActivityDevice(
      decodeURIComponent(deviceMatch[1]),
      requestUser(ctx, body?.user),
      ctx.authUser?.login,
    );
    return "error" in result
      ? Response.json(result, { status: 403 })
      : Response.json(result);
  }

  return undefined;
}
