/**
 * Code-seeded Plain ticket triage automation (single source of truth in git).
 * Create-if-absent by eventKey, so UI edits are preserved; the prompt lives in
 * triage-prompt.ts. Seeded from the Plain agent's startup().
 */
import { listAutomations, createAutomation } from "../../server/automations";
import { TRIAGE_PROMPT } from "./triage-prompt";

const EVENT_KEY = "plain:thread_created";

export function ensureTriageAutomation(): void {
  if (listAutomations().some((a) => a.eventKey === EVENT_KEY)) return;
  const created = createAutomation({
    name: "Plain ticket triage",
    prompt: TRIAGE_PROMPT,
    schedule: "", // event-triggered only (fired by the Plain webhook)
    mode: "code",
    createdBy: "Michael (plain agent)",
    eventKey: EVENT_KEY,
    mcpServers: [
      "plain",
      "workos",
      "tinybird",
      "linear",
      "sentry",
      "stripe",
      "TellaInternalSupportMCP",
      "grafana",
      "slack",
    ],
    fallbackModel: "gpt-5.5",
  });
  if ("error" in created) {
    console.error(`[plain] Failed to seed triage automation:`, created.error);
  } else {
    console.log(`[plain] Seeded "Plain ticket triage" automation (${created.id})`);
  }
}
