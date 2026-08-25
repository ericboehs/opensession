import { sessionAsk } from "./kernel";
import { immutableCopy } from "./immutable-copy";

const globalResolvers = globalThis as typeof globalThis & {
  __opensessionAskRuntimeFields?: Map<string, Record<string, unknown>>;
};
const runtimeFields = (globalResolvers.__opensessionAskRuntimeFields ??=
  new Map());

function splitValue(value: unknown): {
  durable: unknown;
  ephemeral: Record<string, unknown>;
} {
  if (!value || typeof value !== "object")
    return { durable: value, ephemeral: {} };
  const durable: Record<string, unknown> = {};
  const ephemeral: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "function") ephemeral[key] = item;
    else durable[key] = immutableCopy(item);
  }
  return { durable, ephemeral };
}

/** Durable ask facts in the actor, merged with gateway-only resolver closures. */
export class AskOwnedMap<V> implements Map<string, V> {
  readonly [Symbol.toStringTag] = "AskOwnedMap";
  get size(): number {
    return sessionAsk({ op: "entries" }).length;
  }
  clear(): void {
    sessionAsk({ op: "clear" });
    runtimeFields.clear();
  }
  delete(sessionId: string): boolean {
    runtimeFields.delete(sessionId);
    return sessionAsk({ op: "delete", sessionId });
  }
  get(sessionId: string): V | undefined {
    const durable = sessionAsk({ op: "snapshot", sessionId });
    if (durable === undefined) return undefined;
    return immutableCopy({
      ...(durable as Record<string, unknown>),
      ...(runtimeFields.get(sessionId) ?? {}),
    } as V);
  }
  has(sessionId: string): boolean {
    return sessionAsk({ op: "snapshot", sessionId }) !== undefined;
  }
  set(sessionId: string, value: V): this {
    const { durable, ephemeral } = splitValue(value);
    if (Object.keys(ephemeral).length) runtimeFields.set(sessionId, ephemeral);
    else runtimeFields.delete(sessionId);
    sessionAsk({ op: "set", sessionId, value: durable });
    return this;
  }
  private list(): Array<[string, V]> {
    return sessionAsk({ op: "entries" }).map(([sessionId]) => [
      sessionId,
      this.get(sessionId)!,
    ]);
  }
  entries(): MapIterator<[string, V]> {
    return this.list()[Symbol.iterator]();
  }
  keys(): MapIterator<string> {
    return this.list()
      .map(([key]) => key)
      [Symbol.iterator]();
  }
  values(): MapIterator<V> {
    return this.list()
      .map(([, value]) => value)
      [Symbol.iterator]();
  }
  forEach(
    callbackfn: (value: V, key: string, map: Map<string, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.list())
      callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[string, V]> {
    return this.entries();
  }
}

/** Process-only executor handles. They are not actor state. */
export class EphemeralSessionMap<V> extends Map<string, V> {}
export class EphemeralSessionSet extends Set<string> {}
