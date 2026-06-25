/**
 * Upload-processing-failure Agent — polls the Grafana `UploadProcessingFailure`
 * signal and starts one deduplicated Michael investigation per broken upload.
 *
 * The alert is a Loki instant query that already labels each failure with
 * streaming_upload_id / user_email / workflow_id / run_id / namespace, so we
 * re-run that same query on a timer (the alert only re-notifies on state
 * transitions, which is lossy for per-upload fan-out — owning the query gives a
 * clean, complete list each interval and lets us own the dedup).
 *
 * For each upload we haven't already investigated in the last 7 days we:
 *   1. post a control card to #event-process-upload-failures with
 *      Open-in-Backstage + Stop buttons (parity with a Slack-started Michael
 *      session), and
 *   2. run the "Upload processing failure investigation" automation (mode:
 *      code) bound to that pre-generated session id, threading its findings
 *      under the card.
 *
 * Investigation only — never retries the workflow, never triggers re-upload /
 * recovery, only opens a PR when the run is highly confident; otherwise it
 * discusses in Slack.
 */
import { randomUUIDv7 } from "bun";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import type { AgentModule } from "../types";
import {
  listAutomations,
  createAutomation,
  saveAutomation,
  runAutomation,
  type Automation,
} from "../../server/automations";
import { postSlackBlocks, updateSlackBlocks } from "../slack/slack-api";
import {
  UPLOAD_EVENT_KEY,
  UPLOAD_AUTOMATION_NAME,
  UPLOAD_INVESTIGATION_PROMPT,
} from "./prompt";

const HOME = process.env.HOME || "/home/ubuntu";
const DEDUP_DIR = `${HOME}/.backstage-upload-investigations`;

const GRAFANA_URL = process.env.GRAFANA_URL || "";
const GRAFANA_TOKEN = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN || "";
const LOKI_DATASOURCE_UID = process.env.LOKI_DATASOURCE_UID || "loki";

// Channel #event-process-upload-failures. Overridable, but the id is stable.
const SLACK_CHANNEL = process.env.SLACK_UPLOAD_FAILURE_CHANNEL || "C0AKPJ65BQA";

const UI_BASE = process.env.MICHAEL_UI_BASE || "https://michael.taila5d766.ts.net/backstage";

// Only investigate prod failures; stage processing fails routinely during testing.
const NAMESPACE = "prod";

// Re-run the alert's own instant query. A 20m range vector with a 15m cadence
// overlaps so a failure can't slip between polls.
const LOOKBACK = "20m";
const POLL_INTERVAL_MS = 15 * 60 * 1000;

// One broken upload = one investigation per week, no matter how many times the
// workflow retries (new run ids).
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const LOKI_QUERY = `sum by (streaming_upload_id, user_email, workflow_id, run_id, namespace) (count_over_time({service_name="temporal-rust-worker", detected_level="error"} | workflow_type="process_streaming_upload" |= "workflow_failure" [${LOOKBACK}]))`;

mkdirSync(DEDUP_DIR, { recursive: true });

interface FailingUpload {
  streamingUploadId: string;
  userEmail?: string;
  namespace: string;
  /** Deterministic processing workflow id: `process-streaming-upload-<su_...>`. */
  workflowId: string;
  /** Distinct Temporal run ids seen failing (retries). */
  runIds: string[];
}

interface DedupRecord {
  streamingUploadId: string;
  firstSeen: string;
  lastInvestigatedAt: string;
  bksSessionId: string;
  slackTs?: string;
  workflowId?: string;
}

// ── Loki ─────────────────────────────────────────────────────

interface LokiSeries {
  metric: Record<string, string>;
  value: [number, string];
}

async function queryLoki(): Promise<LokiSeries[]> {
  const endpoint = `${GRAFANA_URL}/api/datasources/proxy/uid/${LOKI_DATASOURCE_UID}/loki/api/v1/query`;
  const url = new URL(endpoint);
  url.searchParams.set("query", LOKI_QUERY);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${GRAFANA_TOKEN}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.error(`[upload] Loki query failed: ${resp.status} ${await resp.text()}`);
      return [];
    }
    const data = (await resp.json()) as any;
    if (data?.status !== "success") {
      console.error("[upload] Loki query non-success:", JSON.stringify(data).slice(0, 300));
      return [];
    }
    return (data.data?.result || []) as LokiSeries[];
  } finally {
    clearTimeout(timer);
  }
}

/** Collapse Loki series (one per upload+workflow+run) into one row per upload. */
function groupByUpload(series: LokiSeries[]): FailingUpload[] {
  const byUpload = new Map<string, FailingUpload>();

  for (const s of series) {
    const m = s.metric;
    if ((m.namespace || "") !== NAMESPACE) continue;
    const streamingUploadId = m.streaming_upload_id;
    if (!streamingUploadId) continue;

    const workflowId = m.workflow_id || `process-streaming-upload-${streamingUploadId}`;
    const runId = m.run_id || "";
    const existing = byUpload.get(streamingUploadId);

    if (!existing) {
      byUpload.set(streamingUploadId, {
        streamingUploadId,
        userEmail: m.user_email && m.user_email !== "None" ? m.user_email : undefined,
        namespace: m.namespace,
        workflowId,
        runIds: runId ? [runId] : [],
      });
      continue;
    }

    if (runId && !existing.runIds.includes(runId)) existing.runIds.push(runId);
    if (!existing.userEmail && m.user_email && m.user_email !== "None") {
      existing.userEmail = m.user_email;
    }
  }

  return [...byUpload.values()];
}

// ── Dedup store ──────────────────────────────────────────────

function dedupPath(streamingUploadId: string): string {
  return `${DEDUP_DIR}/${streamingUploadId}.json`;
}

function readDedup(streamingUploadId: string): DedupRecord | null {
  const path = dedupPath(streamingUploadId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DedupRecord;
  } catch {
    return null;
  }
}

function recentlyInvestigated(streamingUploadId: string): boolean {
  const rec = readDedup(streamingUploadId);
  if (!rec) return false;
  const last = Date.parse(rec.lastInvestigatedAt);
  if (Number.isNaN(last)) return false;
  return Date.now() - last < DEDUP_WINDOW_MS;
}

function writeDedup(rec: DedupRecord): void {
  writeFileSync(dedupPath(rec.streamingUploadId), JSON.stringify(rec, null, 2));
}

// ── Automation record ────────────────────────────────────────

/** Find the upload-investigation automation, creating it on first run. */
function ensureAutomation(): Automation | null {
  const existing = listAutomations().find((a) => a.eventKey === UPLOAD_EVENT_KEY);
  if (existing) {
    // Keep the playbook in sync with the repo source of truth.
    if (existing.prompt !== UPLOAD_INVESTIGATION_PROMPT) {
      const updated: Automation = { ...existing, prompt: UPLOAD_INVESTIGATION_PROMPT };
      saveAutomation(updated);
      return updated;
    }
    return existing;
  }

  const created = createAutomation({
    name: UPLOAD_AUTOMATION_NAME,
    prompt: UPLOAD_INVESTIGATION_PROMPT,
    schedule: "", // event/poller-driven only
    mode: "code", // can open a PR
    createdBy: "Michael (upload-failure poller)",
    eventKey: UPLOAD_EVENT_KEY,
    mcpServers: ["TellaInternalSupportMCP", "slack", "grafana"],
    model: "claude-opus-4-8",
  });
  if ("error" in created) {
    console.error("[upload] Failed to create automation:", created.error);
    return null;
  }
  console.log(`[upload] Created automation "${UPLOAD_AUTOMATION_NAME}" (${created.id})`);
  return created;
}

// ── Slack control card ───────────────────────────────────────

function controlCardBlocks(upload: FailingUpload, bksId: string, running: boolean) {
  const who = upload.userEmail ? `*${upload.userEmail}*` : "*Upload processing failure*";
  const retries = upload.runIds.length > 1 ? `  ·  *Attempts:* ${upload.runIds.length}` : "";

  const sectionText = [
    `:mag: Investigating upload processing failure — ${who}`,
    `*Upload:* \`${upload.streamingUploadId}\`${retries}`,
  ].join("\n");

  const backstageButton = {
    type: "button",
    text: { type: "plain_text", text: ":desktop_computer: Open in Backstage", emoji: true },
    url: `${UI_BASE}/session/${bksId}`,
    action_id: `backstage:${bksId}`,
  };
  const stopButton = {
    type: "button",
    text: { type: "plain_text", text: ":octagonal_sign: Stop", emoji: true },
    style: "danger",
    action_id: `upload-stop:${bksId}`,
    value: bksId,
  };

  return [
    { type: "section", text: { type: "mrkdwn", text: sectionText } },
    {
      type: "actions",
      block_id: `upload-investigation-${bksId}`,
      elements: running ? [backstageButton, stopButton] : [backstageButton],
    },
  ];
}

// ── Investigate one upload ───────────────────────────────────

async function investigateUpload(
  upload: FailingUpload,
  automation: Automation,
  onSessionInvalidate?: () => void
): Promise<void> {
  const bksId = `bks-${randomUUIDv7()}`;
  const nowIso = new Date().toISOString();

  // Claim the dedup slot BEFORE the async work so an overlapping poll can't
  // double-fire the same upload.
  const prior = readDedup(upload.streamingUploadId);
  writeDedup({
    streamingUploadId: upload.streamingUploadId,
    firstSeen: prior?.firstSeen || nowIso,
    lastInvestigatedAt: nowIso,
    bksSessionId: bksId,
    workflowId: upload.workflowId,
  });

  // Post the control card first so we have its thread ts to hand to the run.
  let slackTs: string | undefined;
  try {
    const card = await postSlackBlocks(
      SLACK_CHANNEL,
      `Investigating upload processing failure for ${upload.userEmail || upload.streamingUploadId}`,
      controlCardBlocks(upload, bksId, true)
    );
    slackTs = card?.ts;
  } catch (e) {
    console.error("[upload] Failed to post Slack control card:", e);
  }

  if (slackTs) {
    writeDedup({
      streamingUploadId: upload.streamingUploadId,
      firstSeen: prior?.firstSeen || nowIso,
      lastInvestigatedAt: nowIso,
      bksSessionId: bksId,
      slackTs,
      workflowId: upload.workflowId,
    });
  }

  const eventContext = JSON.stringify(
    {
      source: "upload-failure-poller",
      streamingUploadId: upload.streamingUploadId,
      userEmail: upload.userEmail || null,
      namespace: upload.namespace,
      workflowId: upload.workflowId,
      runIds: upload.runIds,
      title: `Upload processing failure — ${upload.userEmail || upload.streamingUploadId}`,
      slackChannelId: SLACK_CHANNEL,
      slackThreadTs: slackTs || null,
    },
    null,
    2
  );

  console.log(`[upload] Investigating ${upload.streamingUploadId} → ${bksId}`);

  // Fire the run in the background so multiple failing uploads investigate
  // concurrently (event-triggered automation runs are allowed to overlap). The
  // poll loop only serializes the cheap setup above, not the runs themselves.
  void runAutomation(automation, onSessionInvalidate, {
    trigger: "event",
    bksSessionId: bksId,
    eventContext,
  })
    .catch((e) => console.error(`[upload] runAutomation failed for ${upload.streamingUploadId}:`, e))
    .finally(() => {
      // Collapse the card to the Backstage link once the run has finished.
      if (!slackTs) return;
      void updateSlackBlocks(
        SLACK_CHANNEL,
        slackTs,
        `Upload-processing-failure investigation for ${upload.userEmail || upload.streamingUploadId}`,
        controlCardBlocks(upload, bksId, false)
      ).catch(() => {});
    });
}

// ── Poll ─────────────────────────────────────────────────────

let polling = false;

async function poll(automation: Automation, onSessionInvalidate?: () => void): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const series = await queryLoki();
    const uploads = groupByUpload(series);
    if (!uploads.length) return;

    const fresh = uploads.filter((u) => !recentlyInvestigated(u.streamingUploadId));
    console.log(
      `[upload] Poll: ${uploads.length} failing upload${uploads.length === 1 ? "" : "s"}, ${fresh.length} new`
    );

    // Sequentially so the dedup claim of one is committed before the next —
    // investigations themselves run concurrently as event automations.
    for (const upload of fresh) {
      await investigateUpload(upload, automation, onSessionInvalidate);
    }
  } catch (e) {
    console.error("[upload] Poll error:", e);
  } finally {
    polling = false;
  }
}

// ── Agent module ─────────────────────────────────────────────

export class UploadAgent implements AgentModule {
  name = "upload";

  private timer: ReturnType<typeof setInterval> | null = null;
  private automation: Automation | null = null;
  private readonly onSessionInvalidate?: () => void;

  constructor(opts?: { onSessionInvalidate?: () => void }) {
    this.onSessionInvalidate = opts?.onSessionInvalidate;
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();

    // Manual trigger: POST /upload/investigate/<secret> { "streamingUploadId": "su_..." }
    // Secret is the automation's webhook secret (path-auth, same model as the
    // automations webhook). Used for ad-hoc re-investigation and test runs.
    routes.set("POST /upload/investigate/*", async (req, url) => {
      const m = url.pathname.match(/^\/upload\/investigate\/([^/]+)$/);
      if (!m) return Response.json({ error: "Bad path" }, { status: 400 });

      const automation = this.automation || ensureAutomation();
      if (!automation) return Response.json({ error: "No automation" }, { status: 500 });
      this.automation = automation;

      if (!automation.webhookSecret || automation.webhookSecret !== m[1]) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }

      let body: any = {};
      try {
        body = await req.json();
      } catch {}
      const streamingUploadId =
        typeof body?.streamingUploadId === "string" ? body.streamingUploadId.trim() : "";
      if (!streamingUploadId) {
        return Response.json({ error: "streamingUploadId required" }, { status: 400 });
      }

      const force = body?.force === true;
      if (!force && recentlyInvestigated(streamingUploadId)) {
        return Response.json({ ok: false, skipped: "investigated within 7 days" });
      }

      // Enrich from Loki if the upload currently shows in the failure signal;
      // otherwise investigate with just the id.
      const uploads = groupByUpload(await queryLoki());
      const upload: FailingUpload =
        uploads.find((u) => u.streamingUploadId === streamingUploadId) || {
          streamingUploadId,
          namespace: NAMESPACE,
          workflowId: `process-streaming-upload-${streamingUploadId}`,
          runIds: [],
        };

      void investigateUpload(upload, automation, this.onSessionInvalidate);
      return Response.json({ ok: true, streamingUploadId });
    });

    return routes;
  }

  async startup(): Promise<void> {
    if (!GRAFANA_URL || !GRAFANA_TOKEN) {
      console.warn("[upload] GRAFANA_URL/GRAFANA_SERVICE_ACCOUNT_TOKEN unset — poller disabled");
      return;
    }
    this.automation = ensureAutomation();
    if (!this.automation) {
      console.error("[upload] No automation record — poller disabled");
      return;
    }

    const tick = () => {
      const automation = this.automation;
      if (automation && automation.enabled) {
        void poll(automation, this.onSessionInvalidate);
      }
    };
    // Refresh the automation record each tick (it may be edited/disabled in the
    // UI) and re-run the poll.
    this.timer = setInterval(() => {
      this.automation =
        listAutomations().find((a) => a.eventKey === UPLOAD_EVENT_KEY) || this.automation;
      tick();
    }, POLL_INTERVAL_MS);

    console.log(
      `[upload] Agent started — polling Loki every ${POLL_INTERVAL_MS / 60000}m → #event-process-upload-failures`
    );
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  health(): Record<string, unknown> {
    return {
      status: GRAFANA_URL && GRAFANA_TOKEN ? "operational" : "missing GRAFANA credentials",
      automation: this.automation?.id || null,
      enabled: this.automation?.enabled ?? false,
      channel: SLACK_CHANNEL,
    };
  }
}
