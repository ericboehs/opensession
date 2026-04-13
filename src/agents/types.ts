/**
 * Interface for agent modules that plug into the webhook server.
 * Each agent registers its routes, lifecycle hooks, and health info.
 */
export interface AgentModule {
  /** Display name (e.g. "slack", "linear", "plain") */
  name: string;

  /** Return a map of "METHOD /path" → handler. Example key: "POST /slack/events" */
  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>>;

  /** Called once at startup — restore state, start background tasks */
  startup(): Promise<void>;

  /** Called on graceful shutdown — clean up processes, save state */
  shutdown(): Promise<void>;

  /** Return health info for the combined /health endpoint */
  health(): Record<string, unknown>;
}
