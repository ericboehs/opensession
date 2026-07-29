/**
 * Tella module — the reference feed plugin (docs/feeds-design.md W4).
 *
 * Contributes the "tella" sidebar feed (recent videos on the viewer's MCP
 * grant) via AgentModule.getFeed(); the descriptor carries the Video panel
 * template and the session MCP allowlist, so the whole item → workspace →
 * scratch session → tab flow rides the generic machinery. No webhook routes
 * yet — a `tella:video_created` route here is the natural next contribution
 * (fires automations exactly like plain:thread_created).
 *
 * Self-gating: loaded unconditionally, but getFeed() returns null until the
 * tella MCP server exists in mcp-config AND someone has connected a grant —
 * an unconfigured module simply contributes nothing.
 */
import type { AgentModule } from "../types";
import type { FeedProvider } from "../../server/feeds";
import { tellaFeedProvider } from "./feed";
import { tellaConfigured } from "./api";

export class TellaAgent implements AgentModule {
  name = "tella";

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    return new Map();
  }

  async startup(): Promise<void> {}

  async shutdown(): Promise<void> {}

  health(): Record<string, unknown> {
    return {
      status: tellaConfigured() ? "operational" : "needs-auth",
      feed: tellaConfigured(),
    };
  }

  getFeed(): FeedProvider | null {
    return tellaFeedProvider();
  }
}
