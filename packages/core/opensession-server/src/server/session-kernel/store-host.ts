import { dirname } from "node:path";
import {
  SessionKernelStore,
  sessionKernelDbPath,
  sessionKernelSessionDbPath,
  type DurableOutboxItem,
  type DurableRunState,
  type DurableSessionQuarantine,
  type DurableTimer,
  type SessionKernelStoreApi,
} from "./store";
import { sessionKernelStoreRoute } from "./store-routing";
import { TranscriptStore } from "../transcript-store";
import type {
  TranscriptActorRequest,
  TranscriptActorResult,
} from "./transcript-protocol";

function minDefined(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length === 0 ? undefined : Math.min(...present);
}

const CENTRAL_STORE_FAILURE = "SESSION_KERNEL_CENTRAL_STORE_FAILURE";
// Global runtime turns share the actor service with latency-sensitive session
// commands. Keep every turn small: the cursor makes progress across calls,
// while a bounded slice prevents startup recovery from opening hundreds of
// SQLite databases behind one global barrier.
const RUNTIME_WAKE_CANDIDATE_BATCH = 16;
const SPARSE_PROJECTION_BACKFILL_BATCH = 128;
const OUTBOX_ROUTE_MAINTENANCE_BATCH = 8;
const SESSION_STORE_MAINTENANCE_BATCH = 1;

class SparseProjectionBackfillPendingError extends Error {
  readonly retryable = true;
}

const SPARSE_PROJECTION_MUTATIONS = new Set([
  "setAskRecord",
  "answerAskRecord",
  "deleteAskRecord",
  "setDeliverySlot",
  "deleteDeliverySlot",
  "prepareSteerDelivery",
  "acceptSteerDelivery",
  "rejectSteerDelivery",
  "requeueSteerDeliveries",
  "ackDeliveryDispatch",
  "failDeliveryDispatch",
  "prepareDeliveryInterrupt",
  "beginDeliveryInterruptEffect",
  "settleDeliveryInterrupt",
  "claimNextDeliveryDispatch",
  "claimDeliveryDispatch",
  "clearSession",
  "tombstoneSession",
]);

export function isSessionKernelCentralStoreFailure(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error &&
    (error as { code?: unknown }).code === CENTRAL_STORE_FAILURE;
}

export function isSessionKernelInfrastructureFailure(error: unknown): boolean {
  if (isSessionKernelCentralStoreFailure(error)) return true;
  const code = error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  if (code.startsWith("SQLITE_") && !code.startsWith("SQLITE_CONSTRAINT")) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|disk i\/o|disk full|database.*(?:malformed|corrupt)|not a database|readonly database/i.test(message);
}

function centralStoreFailure(error: unknown): Error & { code: string } {
  const wrapped = new Error(
    error instanceof Error ? error.message : String(error),
    { cause: error },
  ) as Error & { code: string };
  wrapped.code = CENTRAL_STORE_FAILURE;
  return wrapped;
}

/**
 * Routes one session to exactly one authoritative SQLite store.
 *
 * Existing central sessions move in bounded, verified maintenance batches. A
 * session with no central durable rows is claimed in the placement catalog
 * before its first mutation and writes only its own DB.
 * The durable dirty bit is committed before every isolated mutation, making
 * the global wake index conservative and repairable after a crash.
 */
export class SessionKernelStoreHost {
  readonly central: SessionKernelStore;
  private readonly isolated = new Map<string, SessionKernelStore>();
  private readonly transcripts = new Map<string, TranscriptStore>();
  private runtimeCursor = "";
  private maintenanceSessionCursor = "";
  private outboxRouteMaintenanceCursor = 0;
  constructor(
    private readonly centralPath = sessionKernelDbPath(),
    private readonly isolatedRoot = `${dirname(centralPath)}/session-kernel-sessions`,
    private readonly maxOpenSessionStores = Math.max(
      1,
      Number(process.env.OPENSESSION_SESSION_KERNEL_ACTIVE_STORES ?? 64),
    ),
  ) {
    if (!Number.isInteger(maxOpenSessionStores) || maxOpenSessionStores > 1_024)
      throw new Error("Invalid active session store bound");
    this.central = new SessionKernelStore(centralPath);
  }

  close(): void {
    for (const store of this.transcripts.values()) store.close();
    this.transcripts.clear();
    for (const store of this.isolated.values()) store.close();
    this.isolated.clear();
    this.central.close();
  }

  private centralOperation<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw centralStoreFailure(error);
    }
  }

  isIsolated(sessionId: string): boolean {
    return this.centralOperation(
      () => this.central.sessionPlacement(sessionId)?.placement === "isolated",
    );
  }

  quarantinedSession(sessionId: string): DurableSessionQuarantine | undefined {
    const infrastructure = this.centralOperation(
      () => this.central.quarantinedSession(sessionId),
    );
    if (infrastructure) {
      if (!infrastructure.repairable || !this.isIsolated(sessionId))
        return infrastructure;
      const evidence = this.containIsolated(
        sessionId,
        "storage:quarantine-repair-evidence",
        () => this.openIsolated(sessionId).quarantineRepairEvidence(
          sessionId,
          infrastructure.commandKind,
        ),
      );
      return {
        ...infrastructure,
        repairable: evidence.ok && evidence.value,
      };
    }
    if (!this.isIsolated(sessionId)) return undefined;
    const isolated = this.containIsolated(
      sessionId,
      "storage:quarantine-read",
      () => this.openIsolated(sessionId).quarantinedSession(sessionId),
    );
    return isolated.ok
      ? isolated.value
      : this.centralOperation(() => this.central.quarantinedSession(sessionId));
  }

  quarantineSession(
    sessionId: string,
    reason: string,
    commandKind: string,
    infrastructure = false,
  ): DurableSessionQuarantine {
    const isolatedBefore = this.isIsolated(sessionId);
    if (isolatedBefore)
      this.centralOperation(
        () => this.central.markIsolatedSessionProjectionDirty(sessionId),
      );
    const quarantine = infrastructure && isolatedBefore
      ? this.centralOperation(
          () => this.central.quarantineSession(sessionId, reason, commandKind),
        )
      : this.storeForSession(sessionId, true, true).quarantineSession(
          sessionId,
          reason,
          commandKind,
        );
    const isolated = isolatedBefore || this.isIsolated(sessionId);
    if (isolated) {
      if (infrastructure)
        this.centralOperation(() => this.central.settleIsolatedSessionProjection(
          sessionId,
          undefined,
          undefined,
          quarantine,
        ));
      else this.refreshSessionProjections(sessionId);
    }
    return quarantine;
  }

  storeForSession(
    sessionId: string,
    mutation = false,
    projectionMutation = false,
  ): SessionKernelStore {
    const placement = this.centralOperation(
      () => this.central.sessionPlacement(sessionId),
    );
    if (placement) {
      if (mutation)
        this.centralOperation(() => this.central.markIsolatedSessionDirty(sessionId));
      if (projectionMutation)
        this.centralOperation(
          () => this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
      return this.openIsolated(sessionId);
    }
    if (
      !mutation ||
      this.centralOperation(() => this.central.hasSessionDurableState(sessionId))
    ) return this.central;
    this.centralOperation(() => this.central.claimIsolatedSession(sessionId));
    if (projectionMutation)
      this.centralOperation(
        () => this.central.markIsolatedSessionProjectionDirty(sessionId),
      );
    return this.openIsolated(sessionId);
  }

  transcript<T extends TranscriptActorRequest>(
    request: T,
  ): TranscriptActorResult<T> {
    const placement = this.centralOperation(
      () => this.central.sessionPlacement(request.sessionId),
    );
    if (!placement || placement.placement !== "isolated" ||
        placement.transcriptAuthority !== "actor")
      throw new Error(
        `Session ${request.sessionId} has no isolated actor transcript placement`,
      );
    const mutation = "requestId" in request || request.op === "ack_wake";
    if (mutation)
      this.centralOperation(() => this.central.markIsolatedSessionDirty(request.sessionId));
    const store = this.openTranscript(request.sessionId);
    let result: unknown;
    switch (request.op) {
      case "append":
      case "append_destination":
      case "import":
      case "replace":
      case "delete":
        result = store.applyActorRequest(request);
        break;
      case "needs_import": result = store.needsImport(request.sessionId); break;
      case "import_info": result = store.getImportInfo(request.sessionId); break;
      case "tail": result = store.readTail(request.sessionId, request.limit); break;
      case "tail_window": result = store.readTailWindow(request.sessionId, request.options); break;
      case "since": result = store.readSince(request.sessionId, request.sinceSeq, request.limit); break;
      case "changes_since": result = store.readChangesSince(request.sessionId, request.changeSeq, request.limit); break;
      case "before": result = store.readBefore(request.sessionId, request.beforeSeq, request.limit); break;
      case "range":
        result = store.readRange(
          request.sessionId,
          request.fromSeq,
          request.toSeq,
          request.afterSeq ?? request.fromSeq - 1,
          request.limit,
        );
        break;
      case "outline": result = store.readTranscriptIndex(request.sessionId); break;
      case "full_entry": result = store.getFullEntry(request.sessionId, request.entryId); break;
      case "last_seq": result = store.getLastSeq(request.sessionId); break;
      case "last_change_seq": result = store.getLastChangeSeq(request.sessionId); break;
      case "last_reset_change_seq": result = store.getLastResetChangeSeq(request.sessionId); break;
      case "count": result = store.countEvents(request.sessionId); break;
      case "summary": result = store.applyActorRequest(request); break;
      case "search": result = store.applyActorRequest(request); break;
      case "pending_wake": result = store.pendingActorWake(request.sessionId); break;
      case "ack_wake": result = store.ackActorWake(request.sessionId, request.cursor); break;
      default: {
        const exhaustive: never = request;
        throw new Error(`Unsupported transcript request ${(exhaustive as { op?: string }).op}`);
      }
    }
    return result as TranscriptActorResult<T>;
  }

  private outboxRoute(id: number): { central?: string; isolated?: string } {
    const central = this.centralOperation(() => this.central.outboxSessionId(id));
    const isolated = this.centralOperation(
      () => this.central.isolatedOutboxSessionId(id),
    );
    if (central && isolated)
      throw centralStoreFailure(new Error(
        `Outbox ${id} has conflicting central and isolated route evidence`,
      ));
    return { central, isolated };
  }

  storeForOutbox(id: number, mutation = false): SessionKernelStore {
    const route = this.outboxRoute(id);
    if (route.central) return this.central;
    if (!route.isolated) return this.central;
    return this.storeForSession(route.isolated, mutation);
  }

  outboxSessionId(id: number): string | undefined {
    const route = this.outboxRoute(id);
    return route.central ?? route.isolated;
  }

  call(method: string, args: unknown[]): unknown {
    if (method === "quarantinedSession")
      return this.quarantinedSession(String(args[0] ?? ""));
    if (method === "quarantineSession")
      return this.quarantineSession(
        String(args[0] ?? ""),
        String(args[1] ?? ""),
        String(args[2] ?? "unknown"),
      );
    if (method === "releaseQuarantine") {
      const sessionId = String(args[0] ?? "");
      if (!this.quarantinedSession(sessionId)?.repairable) return false;
      let isolatedReleased = false;
      if (this.isIsolated(sessionId)) {
        this.centralOperation(
          () => this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
        const isolated = this.containIsolated(
          sessionId,
          "storage:quarantine-release",
          () => this.openIsolated(sessionId).releaseQuarantine(sessionId),
        );
        if (isolated.ok) isolatedReleased = isolated.value;
      }
      const centralReleased = this.centralOperation(
        () => this.central.releaseQuarantine(sessionId),
      );
      if (centralReleased || isolatedReleased)
        this.refreshSessionProjections(sessionId);
      return centralReleased || isolatedReleased;
    }
    const route = sessionKernelStoreRoute(method, args);
    if (route.scope === "global") return this.callGlobal(method, args);
    if (route.scope === "outbox") {
      if (method === "outboxSessionId") return this.outboxSessionId(route.id);
      const store = this.storeForOutbox(route.id, route.mutation);
      const result = this.invoke(store, method, args);
      if (
        (method === "ackOutbox" ||
          (method === "discardDeadOutbox" && result === true)) &&
        this.centralOperation(() => this.central.isolatedOutboxSessionId(route.id))
      ) this.centralOperation(() => this.central.forgetIsolatedOutboxRoute(route.id));
      return result;
    }
    const result = this.invoke(
      this.storeForSession(
        route.sessionId,
        route.mutation,
        route.mutation && SPARSE_PROJECTION_MUTATIONS.has(method),
      ),
      method,
      args,
    );
    if (route.mutation && SPARSE_PROJECTION_MUTATIONS.has(method))
      this.refreshSessionProjections(route.sessionId);
    return result;
  }

  refreshSessionProjections(sessionId: string): void {
    if (!this.isIsolated(sessionId)) return;
    const store = this.storeForSession(sessionId);
    const quarantined =
      this.centralOperation(() => this.central.quarantinedSession(sessionId)) ||
      store.quarantinedSession(sessionId);
    const ask = quarantined ? undefined : store.askSnapshot(sessionId);
    const delivery = quarantined ? undefined : store.deliverySnapshot(sessionId);
    const sparseDelivery = delivery && (
      delivery.queued.length > 0 ||
      delivery.steered.length > 0 ||
      delivery.pendingSteers.length > 0 ||
      delivery.dispatch !== undefined ||
      delivery.interrupt !== undefined
    ) ? delivery : undefined;
    this.centralOperation(() => this.central.settleIsolatedSessionProjection(
      sessionId,
      ask,
      sparseDelivery,
      quarantined,
    ));
  }

  private repairSparseProjections(
    limit = SPARSE_PROJECTION_BACKFILL_BATCH,
  ): boolean {
    const candidates = this.centralOperation(
      () => this.central.isolatedProjectionPendingSessionIds(limit),
    );
    for (const sessionId of candidates) {
      const repaired = this.containIsolated(
        sessionId,
        "maintenance:sparse-projection",
        () => {
          const centralQuarantine = this.central.quarantinedSession(sessionId);
          if (centralQuarantine) {
            this.central.settleIsolatedSessionProjection(
              sessionId,
              undefined,
              undefined,
              centralQuarantine,
            );
            return;
          }
          const store = this.centralPath === ":memory:"
            ? this.openIsolated(sessionId)
            : new SessionKernelStore(
                sessionKernelSessionDbPath(sessionId, this.isolatedRoot),
                {
                  readonly: true,
                  hydrateRunStateCache: false,
                  // Schemas 29–30 only add central projection fields. Session
                  // ask/delivery/quarantine tables are unchanged from 28.
                  compatibleReadSchemaFloor: 28,
                },
              );
          try {
            const quarantined = store.quarantinedSession(sessionId);
            const ask = quarantined ? undefined : store.askSnapshot(sessionId);
            const delivery = quarantined ? undefined : store.deliverySnapshot(sessionId);
            const sparseDelivery = delivery && (
              delivery.queued.length > 0 ||
              delivery.steered.length > 0 ||
              delivery.pendingSteers.length > 0 ||
              delivery.dispatch !== undefined ||
              delivery.interrupt !== undefined
            ) ? delivery : undefined;
            this.central.settleIsolatedSessionProjection(
              sessionId,
              ask,
              sparseDelivery,
              quarantined,
            );
          } finally {
            if (store !== this.isolated.get(sessionId)) store.close();
          }
        },
      );
      if (!repaired.ok)
        this.centralOperation(() => this.central.settleIsolatedSessionProjection(
          sessionId,
          undefined,
          undefined,
        ));
    }
    const pending = this.centralOperation(
      () => this.central.isolatedProjectionPendingSessionIds(1).length > 0,
    );
    if (!pending && !this.central.sparseProjectionMigrationComplete())
      this.centralOperation(
        () => this.central.markSparseProjectionMigrationComplete(),
      );
    return pending;
  }

  allRunStates(): Array<DurableRunState & { sessionId: string }> {
    return this.mapReadStores("global:run-states", (store) => store.runStates()).flat();
  }

  allAskEntries(): Array<[string, unknown]> {
    const projectionPending = this.repairSparseProjections();
    if (projectionPending)
      throw new SparseProjectionBackfillPendingError(
        "Sparse session projection backfill is still in progress",
      );
    const entries = [
      ...this.central.askEntries(),
      ...this.central.isolatedAskProjectionEntries(),
    ];
    return structuredClone(entries);
  }

  allDeliveryEntries(slot: Parameters<SessionKernelStoreApi["deliveryEntries"]>[0]) {
    const projectionPending = this.repairSparseProjections();
    if (projectionPending)
      throw new SparseProjectionBackfillPendingError(
        "Sparse session projection backfill is still in progress",
      );
    const entries = [
      ...this.central.deliveryEntries(slot),
      ...this.central.isolatedDeliveryProjectionEntries(slot),
    ];
    return structuredClone(entries);
  }

  allQuarantinedSessions(limit = 100, offset = 0): DurableSessionQuarantine[] {
    // Advance old-store backfill without making this latency-sensitive read scan
    // every isolated database in one actor turn. The projection remains durable
    // across actor restarts and every quarantine mutation refreshes it eagerly.
    this.repairSparseProjections(SESSION_STORE_MAINTENANCE_BATCH);
    const unique = new Map<string, DurableSessionQuarantine>();
    for (const entry of [
      ...this.central.quarantinedSessions(Number.MAX_SAFE_INTEGER, 0),
      ...this.central.isolatedQuarantineProjectionEntries(),
    ]) unique.set(entry.sessionId, this.quarantinedSession(entry.sessionId) ?? entry);
    return structuredClone(
      [...unique.values()]
        .sort((a, b) => b.quarantinedAt - a.quarantinedAt)
        .slice(offset, offset + limit),
    );
  }

  runtimeWork(
    now: number,
    timerKinds: string[],
    effectKinds: string[],
    limit: number,
  ): { timers: DurableTimer[]; outbox: DurableOutboxItem[] } {
    this.repairSparseProjections();
    const candidateLimit = Math.max(
      1,
      Math.min(RUNTIME_WAKE_CANDIDATE_BATCH, limit),
    );
    let candidates = this.central.isolatedWakeCandidates(
      now,
      candidateLimit,
      this.runtimeCursor,
    );
    if (candidates.length < candidateLimit && this.runtimeCursor) {
      const wrapped = this.central.isolatedWakeCandidates(
        now,
        candidateLimit - candidates.length,
      );
      const seen = new Set(candidates);
      candidates = [...candidates, ...wrapped.filter((sessionId) => !seen.has(sessionId))];
    }
    if (candidates.length > 0) this.runtimeCursor = candidates.at(-1)!;
    const quota = Math.max(1, Math.ceil(limit / (candidates.length + 1)));
    const timers = this.central.dueTimers(now, Math.min(quota, limit), timerKinds);
    const outbox = this.central.pendingOutbox(now, Math.min(quota, limit), effectKinds);
    for (const sessionId of candidates) {
      const scanned = this.containIsolated(sessionId, "runtime:scan", () => {
        const store = this.openIsolated(sessionId);
        return {
          timers: timers.length < limit
            ? store.dueTimers(now, Math.min(quota, limit - timers.length), timerKinds)
            : [],
          outbox: outbox.length < limit
            ? store.pendingOutbox(now, Math.min(quota, limit - outbox.length), effectKinds)
            : [],
          nextTimerWakeAt: store.nextTimerWakeAt(),
          nextOutboxWakeAt: store.nextOutboxWakeAt(),
        };
      });
      if (!scanned.ok) continue;
      timers.push(...scanned.value.timers);
      outbox.push(...scanned.value.outbox);
      this.central.settleIsolatedSessionWake(
        sessionId,
        scanned.value.nextTimerWakeAt,
        scanned.value.nextOutboxWakeAt,
      );
      if (timers.length >= limit && outbox.length >= limit) break;
    }
    return { timers, outbox };
  }

  stats(): ReturnType<SessionKernelStoreApi["stats"]> {
    const isolated = this.mapIsolatedReadStores(
      "global:stats",
      (store) => store.stats(),
    );
    // Include quarantines created during this scan in the same response.
    const parts = [this.central.stats(), ...isolated];
    const sum = (key: keyof ReturnType<SessionKernelStoreApi["stats"]>) =>
      parts.reduce((total, part) => total + Number(part[key] ?? 0), 0);
    return {
      sessions: sum("sessions"),
      quarantinedSessions: sum("quarantinedSessions"),
      pendingCommands: sum("pendingCommands"),
      indeterminateCommands: sum("indeterminateCommands"),
      pendingTimers: sum("pendingTimers"),
      pendingOutbox: sum("pendingOutbox"),
      deadLetteredOutbox: sum("deadLetteredOutbox"),
      deadLetteredTimers: sum("deadLetteredTimers"),
      oldestPendingCommandAt: minDefined(parts.map((part) => part.oldestPendingCommandAt)),
      oldestIndeterminateCommandAt: minDefined(parts.map((part) => part.oldestIndeterminateCommandAt)),
      oldestPendingTimerAt: minDefined(parts.map((part) => part.oldestPendingTimerAt)),
      oldestPendingOutboxAt: minDefined(parts.map((part) => part.oldestPendingOutboxAt)),
      dbBytes: sum("dbBytes"),
      walBytes: sum("walBytes"),
      pageCount: sum("pageCount"),
      freePages: sum("freePages"),
      schemaVersion: parts[0].schemaVersion,
    };
  }

  migrateLegacySessions(limit = 1): number {
    if (this.centralPath === ":memory:") return 0;
    let migrated = 0;
    for (const sessionId of this.central.legacySessionIds(limit)) {
      const targetPath = sessionKernelSessionDbPath(sessionId, this.isolatedRoot);
      if (this.central.migrateLegacySession(sessionId, targetPath)) migrated += 1;
    }
    return migrated;
  }

  maintain(): boolean {
    let pending = this.repairSparseProjections(SESSION_STORE_MAINTENANCE_BATCH);
    let routes = this.central.isolatedOutboxRoutes(
      OUTBOX_ROUTE_MAINTENANCE_BATCH,
      this.outboxRouteMaintenanceCursor,
    );
    if (routes.length === 0 && this.outboxRouteMaintenanceCursor !== 0) {
      this.outboxRouteMaintenanceCursor = 0;
      routes = this.central.isolatedOutboxRoutes(
        OUTBOX_ROUTE_MAINTENANCE_BATCH,
        0,
      );
    }
    for (const route of routes) {
      this.outboxRouteMaintenanceCursor = route.id;
      if (this.central.quarantinedSession(route.sessionId)) continue;
      const routedSession = this.containIsolated(
        route.sessionId,
        "maintenance:outbox-route",
        () => this.openIsolated(route.sessionId).outboxSessionId(route.id),
      );
      if (routedSession.ok && routedSession.value !== route.sessionId)
        this.central.forgetIsolatedOutboxRoute(route.id);
    }
    pending =
      routes.length === OUTBOX_ROUTE_MAINTENANCE_BATCH ||
      this.central.maintain() ||
      pending;
    const placements = this.central.isolatedSessionPlacements(
      SESSION_STORE_MAINTENANCE_BATCH,
      this.maintenanceSessionCursor,
    );
    if (placements.length === 0 && this.maintenanceSessionCursor) {
      this.maintenanceSessionCursor = "";
    } else {
      for (const { sessionId } of placements) {
        this.maintenanceSessionCursor = sessionId;
        if (this.central.quarantinedSession(sessionId)) continue;
        const result = this.containIsolated(
          sessionId,
          "maintenance:store",
          () => this.openIsolated(sessionId).maintain(),
        );
        if (result.ok) pending = result.value || pending;
      }
      pending =
        placements.length === SESSION_STORE_MAINTENANCE_BATCH || pending;
    }
    return pending;
  }

  private openTranscript(sessionId: string): TranscriptStore {
    let store = this.transcripts.get(sessionId);
    if (store) {
      this.transcripts.delete(sessionId);
      this.transcripts.set(sessionId, store);
      return store;
    }
    while (this.transcripts.size >= this.maxOpenSessionStores) {
      const oldest = this.transcripts.keys().next().value as string | undefined;
      if (!oldest) break;
      this.transcripts.get(oldest)?.close();
      this.transcripts.delete(oldest);
    }
    if (this.centralPath === ":memory:")
      throw new Error("Actor transcript storage requires an isolated file database");
    store = new TranscriptStore(
      sessionKernelSessionDbPath(sessionId, this.isolatedRoot),
      { actorOwned: false },
    );
    this.transcripts.set(sessionId, store);
    return store;
  }

  private openIsolated(sessionId: string): SessionKernelStore {
    let store = this.isolated.get(sessionId);
    if (store) {
      // Refresh insertion order so the bounded cache passivates the least
      // recently used logical actor connection.
      this.isolated.delete(sessionId);
      this.isolated.set(sessionId, store);
      return store;
    }
    while (this.isolated.size >= this.maxOpenSessionStores) {
      const oldestSessionId = this.isolated.keys().next().value as string | undefined;
      if (!oldestSessionId) break;
      const oldest = this.isolated.get(oldestSessionId);
      this.isolated.delete(oldestSessionId);
      oldest?.close();
    }
    store = new SessionKernelStore(
      this.centralPath === ":memory:"
        ? ":memory:"
        : sessionKernelSessionDbPath(sessionId, this.isolatedRoot),
      {
        allocateOutboxId: (owner) => {
          try {
            return this.central.allocateIsolatedOutboxId(owner);
          } catch (error) {
            throw centralStoreFailure(error);
          }
        },
        // Gateway compatibility calls still wait synchronously. Keep a locked
        // session turn short, then quarantine it, rather than blocking the
        // gateway bridge or an actor lane for SQLite's central-store timeout.
        busyTimeoutMs: 250,
      },
    );
    this.isolated.set(sessionId, store);
    return store;
  }

  private containIsolated<T>(
    sessionId: string,
    commandKind: string,
    operation: () => T,
  ): { ok: true; value: T } | { ok: false } {
    try {
      return { ok: true, value: operation() };
    } catch (error) {
      if (
        isSessionKernelCentralStoreFailure(error) ||
        !isSessionKernelInfrastructureFailure(error)
      ) throw error;
      this.centralOperation(() => this.central.quarantineSession(
        sessionId,
        error instanceof Error ? error.message : String(error),
        commandKind,
      ));
      return { ok: false };
    }
  }

  private mapIsolatedReadStores<T>(
    commandKind: string,
    operation: (store: SessionKernelStore, sessionId: string) => T,
  ): T[] {
    const results: T[] = [];
    for (const { sessionId } of this.central.isolatedSessionPlacements()) {
      if (this.central.quarantinedSession(sessionId)) continue;
      const result = this.containIsolated(sessionId, commandKind, () => {
        const cached = this.isolated.get(sessionId);
        if (cached) return operation(cached, sessionId);
        if (this.centralPath === ":memory:")
          return operation(this.openIsolated(sessionId), sessionId);
        let store: SessionKernelStore;
        try {
          store = new SessionKernelStore(
            sessionKernelSessionDbPath(sessionId, this.isolatedRoot),
            { readonly: true, hydrateRunStateCache: false },
          );
        } catch (error) {
          // The first schema-23 read may encounter an additive schema-22 target
          // created before this deploy. Upgrade it once behind the global gate.
          if (!/read mirror schema \d+ does not match supported \d+/.test(
            error instanceof Error ? error.message : String(error),
          )) throw error;
          return operation(this.openIsolated(sessionId), sessionId);
        }
        try {
          return operation(store, sessionId);
        } finally {
          store.close();
        }
      });
      if (result.ok) results.push(result.value);
    }
    return results;
  }

  private mapReadStores<T>(
    commandKind: string,
    operation: (store: SessionKernelStore, sessionId?: string) => T,
  ): T[] {
    return [
      operation(this.central),
      ...this.mapIsolatedReadStores(commandKind, operation),
    ];
  }

  private mapIsolatedStores<T>(
    commandKind: string,
    operation: (store: SessionKernelStore, sessionId: string) => T,
  ): T[] {
    const results: T[] = [];
    for (const { sessionId } of this.central.isolatedSessionPlacements()) {
      if (this.central.quarantinedSession(sessionId)) continue;
      // Operate before opening the next actor. Building an array of store
      // handles first let the bounded LRU close early entries before use.
      const result = this.containIsolated(
        sessionId,
        commandKind,
        () => operation(this.openIsolated(sessionId), sessionId),
      );
      if (result.ok) results.push(result.value);
    }
    return results;
  }

  private mapStores<T>(
    commandKind: string,
    operation: (store: SessionKernelStore, sessionId?: string) => T,
  ): T[] {
    return [operation(this.central), ...this.mapIsolatedStores(commandKind, operation)];
  }

  private invoke(store: SessionKernelStore, method: string, args: unknown[]): unknown {
    const fn = (store as unknown as Record<string, (...values: unknown[]) => unknown>)[method];
    if (typeof fn !== "function") throw new Error(`Unknown store method ${method}`);
    return fn.apply(store, args);
  }

  private callGlobal(method: string, args: unknown[]): unknown {
    if (method === "actorTranscriptSessionIds")
      return this.central.actorTranscriptSessionIds(
        Number(args[0] ?? 100),
        String(args[1] ?? ""),
      );
    if (method === "askMigrationComplete") return this.central.askMigrationComplete();
    if (method === "markAskMigrationComplete") return this.central.markAskMigrationComplete();
    if (method === "deliveryMigrationComplete") return this.central.deliveryMigrationComplete();
    if (method === "markDeliveryMigrationComplete") return this.central.markDeliveryMigrationComplete();
    if (method === "askEntries") return this.allAskEntries();
    if (method === "deliveryEntries")
      return this.allDeliveryEntries(args[0] as Parameters<SessionKernelStoreApi["deliveryEntries"]>[0]);
    if (method === "runStates") return this.allRunStates();
    if (method === "quarantinedSessions")
      return this.allQuarantinedSessions(Number(args[0] ?? 100), Number(args[1] ?? 0));
    if (method === "dueTimers")
      return this.mapReadStores("global:due-timers", (store) => store.dueTimers(
        args[0] as number | undefined,
        args[1] as number | undefined,
        args[2] as readonly string[] | undefined,
      )).flat().slice(0, Number(args[1] ?? 100));
    if (method === "pendingOutbox")
      return this.mapReadStores("global:pending-outbox", (store) => store.pendingOutbox(
        args[0] as number | undefined,
        args[1] as number | undefined,
        args[2] as readonly string[] | undefined,
      )).flat().slice(0, Number(args[1] ?? 100));
    if (method === "stats") return this.stats();
    if (method === "maintain") return this.maintain();
    if (method === "compact") {
      this.mapStores("global:compact", (store) => store.compact(
        args[0] as number | undefined,
        args[1] as number | undefined,
        args[2] as number | undefined,
      ));
      return;
    }
    if (method === "clearAskRecords") {
      if (this.repairSparseProjections())
        throw new SparseProjectionBackfillPendingError(
          "Sparse session projection backfill is still in progress",
        );
      const sessionIds = this.central.isolatedAskProjectionEntries()
        .map(([sessionId]) => sessionId);
      this.central.clearAskRecords();
      for (const sessionId of sessionIds) {
        this.centralOperation(
          () => this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
        this.storeForSession(sessionId, true, true).clearAskRecords();
        this.refreshSessionProjections(sessionId);
      }
      return;
    }
    if (method === "clearDeliverySlot") {
      if (this.repairSparseProjections())
        throw new SparseProjectionBackfillPendingError(
          "Sparse session projection backfill is still in progress",
        );
      const slot = args[0] as Parameters<SessionKernelStoreApi["clearDeliverySlot"]>[0];
      const sessionIds = this.central.isolatedDeliveryProjectionEntries(slot)
        .map(([sessionId]) => sessionId);
      this.central.clearDeliverySlot(slot);
      for (const sessionId of sessionIds) {
        this.centralOperation(
          () => this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
        this.storeForSession(sessionId, true, true).clearDeliverySlot(slot);
        this.refreshSessionProjections(sessionId);
      }
      return;
    }
    if (method === "settlePendingSteers") {
      const projectionPending = this.repairSparseProjections();
      if (projectionPending)
        throw new SparseProjectionBackfillPendingError(
          "Sparse session projection backfill is still in progress",
        );
      let settled = this.central.settlePendingSteers();
      const candidates = this.central.isolatedPendingSteerProjectionSessionIds();
      for (const sessionId of candidates) {
        this.centralOperation(
          () => this.central.markIsolatedSessionProjectionDirty(sessionId),
        );
        const result = this.containIsolated(
          sessionId,
          "global:settle-pending-steers",
          () => this.storeForSession(sessionId, true, true).settlePendingSteers(),
        );
        if (result.ok) {
          settled += result.value;
          this.refreshSessionProjections(sessionId);
        }
      }
      return settled;
    }
    if (method === "retryCompatibleCreationBranchDeadLetters") {
      const destinations = args[0] as Parameters<
        SessionKernelStoreApi["retryCompatibleCreationBranchDeadLetters"]
      >[0];
      const now = args[1] as number | undefined;
      const retried = this.central.retryCompatibleCreationBranchDeadLetters(
        destinations,
        now,
      );
      const candidates = this.mapIsolatedReadStores(
        "global:find-creation-branch-dead-letters",
        (store, sessionId) =>
          store.hasCreationBranchDeadLetters() ? sessionId : undefined,
      ).filter((sessionId): sessionId is string => sessionId !== undefined);
      for (const sessionId of candidates) {
        const result = this.containIsolated(
          sessionId,
          "global:retry-creation-branches",
          () => this.storeForSession(sessionId, true)
            .retryCompatibleCreationBranchDeadLetters(destinations, now),
        );
        if (result.ok) retried.push(...result.value);
      }
      return retried;
    }
    if (method === "deadLetters") {
      const limit = Number(args[0] ?? 100);
      const offset = Number(args[1] ?? 0);
      const isolated = this.mapIsolatedReadStores(
        "global:dead-letters",
        (store) => store.deadLetters(Number.MAX_SAFE_INTEGER, 0),
      );
      const parts = [this.central.deadLetters(Number.MAX_SAFE_INTEGER, 0), ...isolated];
      const byDeadLetter = (a: { deadLetteredAt: number }, b: { deadLetteredAt: number }) =>
        b.deadLetteredAt - a.deadLetteredAt;
      const quarantines = parts.flatMap((part) => part.quarantines)
        .sort((a, b) => b.quarantinedAt - a.quarantinedAt);
      const timers = parts.flatMap((part) => part.timers).sort(byDeadLetter);
      const outbox = parts.flatMap((part) => part.outbox).sort(byDeadLetter);
      return {
        quarantines: quarantines.slice(offset, offset + limit),
        timers: timers.slice(offset, offset + limit),
        outbox: outbox.slice(offset, offset + limit),
        totals: {
          quarantines: quarantines.length,
          timers: timers.length,
          outbox: outbox.length,
        },
        nextOffset:
          Math.max(quarantines.length, timers.length, outbox.length) > offset + limit
            ? offset + limit
            : undefined,
      };
    }
    throw new Error(`Unsupported global store method ${method}`);
  }
}
