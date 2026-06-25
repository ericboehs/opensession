/**
 * Export-failure Agent — polls the Grafana `ExportWorkflowFailure` signal and
 * starts one deduplicated Michael investigation per broken video.
 *
 * The alert is a Loki instant query that already labels each failure with
 * story_id / story_name / workflow_id / run_id / namespace, so we re-run that
 * same query on a timer (the alert only re-notifies on state transitions, which
 * is lossy for per-story fan-out — owning the query gives a clean, complete
 * list each interval and lets us own the dedup).
 *
 * For each story we haven't already investigated in the last 7 days we:
 *   1. post a control card to #event-export-failures with Open-in-Backstage +
 *      Stop buttons (parity with a Slack-started Michael session), and
 *   2. run the "Export failure investigation" automation (mode: code) bound to
 *      that pre-generated session id, threading its findings under the card.
 *
 * Investigation only — never retries the export, never triggers recovery, only
 * opens a PR when the run is highly confident; otherwise it discusses in Slack.
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
  EXPORT_EVENT_KEY,
  EXPORT_AUTOMATION_NAME,
  EXPORT_INVESTIGATION_PROMPT,
} from "./prompt";

const HOME = process.env.HOME || "/home/ubuntu";
const DEDUP_DIR = `${HOME}/.backstage-export-investigations`;

const GRAFANA_URL = process.env.GRAFANA_URL || "";
const GRAFANA_TOKEN = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN || "";
const LOKI_DATASOURCE_UID = process.env.LOKI_DATASOURCE_UID || "loki";

// Channel #event-export-failures. Overridable, but the id is stable.
const SLACK_CHANNEL = process.env.SLACK_EXPORT_FAILURE_CHANNEL || "C093YC3TX8E";

const UI_BASE = process.env.MICHAEL_UI_BASE || "https://michael.taila5d766.ts.net/backstage";

// Only investigate prod failures; stage exports fail routinely during testing.
const NAMESPACE = "prod";

// Re-run the alert's own instant query. A 20m range vector with a 15m cadence
// overlaps so a failure can't slip between polls.
const LOOKBACK = "20m";
const POLL_INTERVAL_MS = 15 * 60 * 1000;

// One broken video = one investigation per week, no matter how many times the
// user retries or how many variants (4K + 1080p) fire.
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const LOKI_QUERY = `sum by (story_id, story_name, workflow_id, run_id, namespace) (count_over_time({service_name="temporal-rust-worker", detected_level="error"} | workflow_type="export" |= "workflow_failure" [${LOOKBACK}]))`;

mkdirSync(DEDUP_DIR, { recursive: true });

interface FailingStory {
  storyId: string;
  storyName?: string;
  namespace: string;
  /** Representative (most recent) failing export workflow id. */
  workflowId: string;
  /** Distinct render dimensions seen failing, e.g. ["3840x2160", "1920x1080"]. */
  dimensions: string[];
  /** Distinct fps values seen, e.g. ["30"]. */
  fps: string[];
}

interface DedupRecord {
  storyId: string;
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
      console.error(`[export] Loki query failed: ${resp.status} ${await resp.text()}`);
      return [];
    }
    const data = (await resp.json()) as any;
    if (data?.status !== "success") {
      console.error("[export] Loki query non-success:", JSON.stringify(data).slice(0, 300));
      return [];
    }
    return (data.data?.result || []) as LokiSeries[];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The workflow id encodes the export request:
 * `Export-Story-<storyId>/<ISO ts>/Story/<WxH>/<fps>FPS`. Parse out the
 * dimensions, fps, and request timestamp so we can pick the most recent attempt
 * as the representative one and list which variants are failing.
 */
function parseWorkflowId(workflowId: string): { ts: string; dims?: string; fps?: string } {
  const parts = workflowId.split("/");
  const ts = parts[1] || "";
  const dims = parts.find((p) => /^\d+x\d+$/.test(p));
  const fpsPart = parts.find((p) => /^\d+FPS$/.test(p));
  return { ts, dims, fps: fpsPart ? fpsPart.replace("FPS", "") : undefined };
}

/** Collapse Loki series (one per story+workflow+run) into one row per story. */
function groupByStory(series: LokiSeries[]): FailingStory[] {
  const byStory = new Map<string, FailingStory & { _latestTs: string }>();

  for (const s of series) {
    const m = s.metric;
    if ((m.namespace || "") !== NAMESPACE) continue;
    const storyId = m.story_id;
    const workflowId = m.workflow_id || "";
    if (!storyId) continue;

    const { ts, dims, fps } = parseWorkflowId(workflowId);
    const existing = byStory.get(storyId);

    if (!existing) {
      byStory.set(storyId, {
        storyId,
        storyName: m.story_name && m.story_name !== "None" ? m.story_name : undefined,
        namespace: m.namespace,
        workflowId,
        dimensions: dims ? [dims] : [],
        fps: fps ? [fps] : [],
        _latestTs: ts,
      });
      continue;
    }

    if (dims && !existing.dimensions.includes(dims)) existing.dimensions.push(dims);
    if (fps && !existing.fps.includes(fps)) existing.fps.push(fps);
    if (!existing.storyName && m.story_name && m.story_name !== "None") {
      existing.storyName = m.story_name;
    }
    // Keep the most recent attempt as the representative workflow id.
    if (ts > existing._latestTs) {
      existing._latestTs = ts;
      existing.workflowId = workflowId;
    }
  }

  return [...byStory.values()].map(({ _latestTs, ...rest }) => rest);
}

// ── Dedup store ──────────────────────────────────────────────

function dedupPath(storyId: string): string {
  return `${DEDUP_DIR}/${storyId}.json`;
}

function readDedup(storyId: string): DedupRecord | null {
  const path = dedupPath(storyId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as DedupRecord;
  } catch {
    return null;
  }
}

function recentlyInvestigated(storyId: string): boolean {
  const rec = readDedup(storyId);
  if (!rec) return false;
  const last = Date.parse(rec.lastInvestigatedAt);
  if (Number.isNaN(last)) return false;
  return Date.now() - last < DEDUP_WINDOW_MS;
}

function writeDedup(rec: DedupRecord): void {
  writeFileSync(dedupPath(rec.storyId), JSON.stringify(rec, null, 2));
}

// ── Automation record ────────────────────────────────────────

/** Find the export-investigation automation, creating it on first run. */
function ensureAutomation(): Automation | null {
  const existing = listAutomations().find((a) => a.eventKey === EXPORT_EVENT_KEY);
  if (existing) {
    // Keep the playbook in sync with the repo source of truth.
    if (existing.prompt !== EXPORT_INVESTIGATION_PROMPT) {
      const updated: Automation = { ...existing, prompt: EXPORT_INVESTIGATION_PROMPT };
      saveAutomation(updated);
      return updated;
    }
    return existing;
  }

  const created = createAutomation({
    name: EXPORT_AUTOMATION_NAME,
    prompt: EXPORT_INVESTIGATION_PROMPT,
    schedule: "", // event/poller-driven only
    mode: "code", // can open a PR
    createdBy: "Michael (export-failure poller)",
    eventKey: EXPORT_EVENT_KEY,
    mcpServers: ["TellaInternalSupportMCP", "slack", "grafana"],
    model: "claude-opus-4-8",
  });
  if ("error" in created) {
    console.error("[export] Failed to create automation:", created.error);
    return null;
  }
  console.log(`[export] Created automation "${EXPORT_AUTOMATION_NAME}" (${created.id})`);
  return created;
}

// ── Slack control card ───────────────────────────────────────

function controlCardBlocks(story: FailingStory, bksId: string, running: boolean) {
  const title = story.storyName ? `*${story.storyName}*` : "*Export failure*";
  const variants = story.dimensions.length ? story.dimensions.join(", ") : "unknown";
  const fps = story.fps.length ? ` @ ${story.fps.join("/")}fps` : "";

  const sectionText = [
    `:mag: Investigating export failure — ${title}`,
    `*Story:* \`${story.storyId}\`  ·  *Variants:* ${variants}${fps}`,
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
    action_id: `export-stop:${bksId}`,
    value: bksId,
  };

  return [
    { type: "section", text: { type: "mrkdwn", text: sectionText } },
    {
      type: "actions",
      block_id: `export-investigation-${bksId}`,
      elements: running ? [backstageButton, stopButton] : [backstageButton],
    },
  ];
}

// ── Investigate one story ────────────────────────────────────

async function investigateStory(
  story: FailingStory,
  automation: Automation,
  onSessionInvalidate?: () => void
): Promise<void> {
  const bksId = `bks-${randomUUIDv7()}`;
  const nowIso = new Date().toISOString();

  // Claim the dedup slot BEFORE the async work so an overlapping poll can't
  // double-fire the same story.
  const prior = readDedup(story.storyId);
  writeDedup({
    storyId: story.storyId,
    firstSeen: prior?.firstSeen || nowIso,
    lastInvestigatedAt: nowIso,
    bksSessionId: bksId,
    workflowId: story.workflowId,
  });

  // Post the control card first so we have its thread ts to hand to the run.
  let slackTs: string | undefined;
  try {
    const card = await postSlackBlocks(
      SLACK_CHANNEL,
      `Investigating export failure for ${story.storyName || story.storyId}`,
      controlCardBlocks(story, bksId, true)
    );
    slackTs = card?.ts;
  } catch (e) {
    console.error("[export] Failed to post Slack control card:", e);
  }

  if (slackTs) {
    writeDedup({
      storyId: story.storyId,
      firstSeen: prior?.firstSeen || nowIso,
      lastInvestigatedAt: nowIso,
      bksSessionId: bksId,
      slackTs,
      workflowId: story.workflowId,
    });
  }

  const eventContext = JSON.stringify(
    {
      source: "export-failure-poller",
      storyId: story.storyId,
      storyName: story.storyName || null,
      namespace: story.namespace,
      workflowId: story.workflowId,
      dimensions: story.dimensions,
      fps: story.fps,
      title: `Export failure — ${story.storyName || story.storyId}`,
      slackChannelId: SLACK_CHANNEL,
      slackThreadTs: slackTs || null,
    },
    null,
    2
  );

  console.log(`[export] Investigating ${story.storyId} → ${bksId}`);

  // Fire the run in the background so multiple failing stories investigate
  // concurrently (event-triggered automation runs are allowed to overlap). The
  // poll loop only serializes the cheap setup above, not the runs themselves.
  void runAutomation(automation, onSessionInvalidate, {
    trigger: "event",
    bksSessionId: bksId,
    eventContext,
  })
    .catch((e) => console.error(`[export] runAutomation failed for ${story.storyId}:`, e))
    .finally(() => {
      // Collapse the card to the Backstage link once the run has finished.
      if (!slackTs) return;
      void updateSlackBlocks(
        SLACK_CHANNEL,
        slackTs,
        `Export-failure investigation for ${story.storyName || story.storyId}`,
        controlCardBlocks(story, bksId, false)
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
    const stories = groupByStory(series);
    if (!stories.length) return;

    const fresh = stories.filter((s) => !recentlyInvestigated(s.storyId));
    console.log(
      `[export] Poll: ${stories.length} failing stor${stories.length === 1 ? "y" : "ies"}, ${fresh.length} new`
    );

    // Sequentially so the dedup claim of one is committed before the next —
    // investigations themselves run concurrently as event automations.
    for (const story of fresh) {
      await investigateStory(story, automation, onSessionInvalidate);
    }
  } catch (e) {
    console.error("[export] Poll error:", e);
  } finally {
    polling = false;
  }
}

// ── Agent module ─────────────────────────────────────────────

export class ExportAgent implements AgentModule {
  name = "export";

  private timer: ReturnType<typeof setInterval> | null = null;
  private automation: Automation | null = null;
  private readonly onSessionInvalidate?: () => void;

  constructor(opts?: { onSessionInvalidate?: () => void }) {
    this.onSessionInvalidate = opts?.onSessionInvalidate;
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<string, (req: Request, url: URL) => Promise<Response>>();

    // Manual trigger: POST /export/investigate/<secret> { "storyId": "vid_..." }
    // Secret is the automation's webhook secret (path-auth, same model as the
    // automations webhook). Used for ad-hoc re-investigation and test runs.
    routes.set("POST /export/investigate/*", async (req, url) => {
      const m = url.pathname.match(/^\/export\/investigate\/([^/]+)$/);
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
      const storyId = typeof body?.storyId === "string" ? body.storyId.trim() : "";
      if (!storyId) return Response.json({ error: "storyId required" }, { status: 400 });

      const force = body?.force === true;
      if (!force && recentlyInvestigated(storyId)) {
        return Response.json({ ok: false, skipped: "investigated within 7 days" });
      }

      // Enrich from Loki if the story currently shows in the failure signal;
      // otherwise investigate with just the id.
      const stories = groupByStory(await queryLoki());
      const story: FailingStory =
        stories.find((s) => s.storyId === storyId) || {
          storyId,
          namespace: NAMESPACE,
          workflowId: "",
          dimensions: [],
          fps: [],
        };

      void investigateStory(story, automation, this.onSessionInvalidate);
      return Response.json({ ok: true, storyId });
    });

    return routes;
  }

  async startup(): Promise<void> {
    if (!GRAFANA_URL || !GRAFANA_TOKEN) {
      console.warn("[export] GRAFANA_URL/GRAFANA_SERVICE_ACCOUNT_TOKEN unset — poller disabled");
      return;
    }
    this.automation = ensureAutomation();
    if (!this.automation) {
      console.error("[export] No automation record — poller disabled");
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
        listAutomations().find((a) => a.eventKey === EXPORT_EVENT_KEY) || this.automation;
      tick();
    }, POLL_INTERVAL_MS);

    console.log(
      `[export] Agent started — polling Loki every ${POLL_INTERVAL_MS / 60000}m → #event-export-failures`
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
