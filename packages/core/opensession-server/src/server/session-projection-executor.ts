import {
  sessionGatewayCommand,
  type GatewayCommandOperation,
} from "./session-kernel";

const projectionState = globalThis as typeof globalThis & {
  __sessionProjectionTails?: Map<string, Promise<void>>;
};

function serializeSessionProjection<T>(
  sessionId: string,
  project: () => Promise<T>,
): Promise<T> {
  const tails = (projectionState.__sessionProjectionTails ??= new Map());
  const prior = tails.get(sessionId) ?? Promise.resolve();
  const result = prior.then(project);
  const tail = result.then(() => undefined, () => undefined);
  tails.set(sessionId, tail);
  void tail.finally(() => {
    if (tails.get(sessionId) === tail) tails.delete(sessionId);
  });
  return result;
}

/**
 * Execute one destination mutation after actor admission. The physical mutation
 * runs on the gateway thread, never in the actor Worker, while admission and
 * exact completion remain durable and ordered with other session projections.
 */
export function executeDestinationIdempotentSessionProjection<T>(
  sessionId: string,
  requestId: string,
  operation: "transcript_destination_append",
  identity: unknown,
  mutate: () => T | Promise<T>,
): Promise<T> {
  return serializeSessionProjection(sessionId, async () => {
    const plan = await sessionGatewayCommand({
      op: "request",
      sessionId,
      requestId,
      operation,
      identity,
    });
    if (plan.status === "completed") return plan.result as T;
    if (plan.status === "in_progress")
      throw new Error(`Destination command ${requestId} is already in progress`);
    let physicalFinished = false;
    try {
      const result = await mutate();
      physicalFinished = true;
      return await sessionGatewayCommand({
        op: "complete",
        sessionId,
        requestId,
        operation,
        result,
      }) as T;
    } catch (error) {
      if (!physicalFinished) {
        await sessionGatewayCommand({
          op: "fail",
          sessionId,
          requestId,
          operation,
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        });
      }
      throw error;
    }
  });
}

export function executeSessionProjection<T>(
  sessionId: string,
  operation: GatewayCommandOperation,
  mutate: () => T | Promise<T>,
): Promise<T> {
  return serializeSessionProjection(sessionId, async () => {
    const requestId = `${operation}:${crypto.randomUUID()}`;
    const plan = await sessionGatewayCommand({
      op: "request",
      sessionId,
      requestId,
      operation,
    });
    if (plan.status !== "execute")
      throw new Error(`Unexpected duplicate ${operation} command`);
    let physicalFinished = false;
    try {
      const result = await mutate();
      physicalFinished = true;
      return await sessionGatewayCommand({
        op: "complete",
        sessionId,
        requestId,
        operation,
        result,
      }) as T;
    } catch (error) {
      if (!physicalFinished) {
        await sessionGatewayCommand({
          op: "fail",
          sessionId,
          requestId,
          operation,
          error: error instanceof Error ? error.message : String(error),
          retryable: false,
        });
      }
      throw error;
    }
  });
}
