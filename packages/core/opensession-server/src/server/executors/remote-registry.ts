import type { RemoteExecutorConnectionOptions } from "./remote";
import { RemoteExecutorConnection } from "./remote";

export class RemoteExecutorRegistrationError extends Error {
  constructor(
    readonly code: "stale_generation" | "duplicate_incarnation",
    message: string,
  ) {
    super(message);
    this.name = "RemoteExecutorRegistrationError";
  }
}

export type RemoteExecutorRegistration = RemoteExecutorConnectionOptions &
  Required<Pick<RemoteExecutorConnectionOptions, "cleanupGrant">>;

/** Explicit registry with one active incarnation per executor and no import-time effects. */
export class RemoteExecutorRegistry {
  readonly #active = new Map<string, RemoteExecutorConnection>();
  readonly #highestGeneration = new Map<string, number>();

  register(registration: RemoteExecutorRegistration): RemoteExecutorConnection {
    const highest = this.#highestGeneration.get(registration.executorId);
    const active = this.#active.get(registration.executorId);
    if (highest !== undefined && registration.generation < highest) {
      throw new RemoteExecutorRegistrationError(
        "stale_generation",
        "executor generation is stale",
      );
    }
    if (active?.connected) {
      if (registration.generation <= active.identity.generation) {
        throw new RemoteExecutorRegistrationError(
          registration.generation === active.identity.generation
            ? "duplicate_incarnation"
            : "stale_generation",
          "executor already has an active incarnation",
        );
      }
      active.disconnect("superseded by a higher executor generation");
    }
    const connection = new RemoteExecutorConnection(registration);
    this.#active.set(registration.executorId, connection);
    this.#highestGeneration.set(
      registration.executorId,
      registration.generation,
    );
    return connection;
  }

  get(executorId: string): RemoteExecutorConnection | undefined {
    const connection = this.#active.get(executorId);
    return connection?.connected && connection.isReady ? connection : undefined;
  }

  disconnect(executorId: string, reason?: unknown): boolean {
    const connection = this.#active.get(executorId);
    if (!connection) return false;
    connection.disconnect(reason);
    this.#active.delete(executorId);
    return true;
  }

  unregisterConnection(connection: RemoteExecutorConnection): boolean {
    if (this.#active.get(connection.identity.executorId) !== connection)
      return false;
    connection.disconnect("unregistered");
    this.#active.delete(connection.identity.executorId);
    return true;
  }

  unregister(
    executorId: string,
    instanceId: string,
    generation: number,
  ): boolean {
    const connection = this.#active.get(executorId);
    if (
      !connection ||
      connection.identity.instanceId !== instanceId ||
      connection.identity.generation !== generation
    )
      return false;
    connection.disconnect("unregistered");
    this.#active.delete(executorId);
    return true;
  }

  shutdown(reason: unknown = "remote Executor registry shut down"): void {
    for (const connection of this.#active.values())
      connection.disconnect(reason);
    this.#active.clear();
  }

  get size(): number {
    return this.#active.size;
  }
}
