/**
 * Plain Agent Module — handles Plain webhook events for the configured mention.
 */
import type { AgentModule } from "../types";
import { verifyPlainSignature } from "../../server/shared/signature";
import { handleWebhook, activeSessions, pendingConfirmations } from "./handlers";
import type { PlainWebhookPayload } from "./handlers";
import { configuredIntegration } from "../../server/config";

const PLAIN_WEBHOOK_SECRET = process.env.PLAIN_WEBHOOK_SECRET || "";

// Clean up old pending confirmations every 5 minutes
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export class PlainAgent implements AgentModule {
  name = "plain";

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();

    routes.set("POST /plain/webhook", async (req) => {
      const body = await req.text();
      const signature = req.headers.get("plain-request-signature") || "";

      if (!verifyPlainSignature(body, signature, PLAIN_WEBHOOK_SECRET)) {
        console.error("[plain] Invalid webhook signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      try {
        const payload = JSON.parse(body) as PlainWebhookPayload;
        return handleWebhook(payload);
      } catch (e) {
        console.error("[plain] Error parsing webhook payload:", e);
        return Response.json({ error: "Invalid payload" }, { status: 400 });
      }
    });

    return routes;
  }

  async startup(): Promise<void> {
    if (configuredIntegration("seeds").enabled === true) {
    }

    // Start confirmation cleanup timer
    cleanupInterval = setInterval(() => {
      const now = Date.now();
      const timeout = 30 * 60 * 1000; // 30 minutes
      for (const [key, pending] of pendingConfirmations) {
        if (now - pending.timestamp > timeout) {
          pendingConfirmations.delete(key);
        }
      }
    }, 5 * 60 * 1000);

    console.log("[plain] Agent started");
  }

  async shutdown(): Promise<void> {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
    console.log("[plain] Agent shut down");
  }

  health(): Record<string, unknown> {
    return {
      status: "operational",
      activeSessions: activeSessions.size,
      pendingConfirmations: pendingConfirmations.size,
    };
  }
}
