/**
 * External session providers — the seam that lets an integration contribute
 * rows to `GET /api/sessions` without owning a session record.
 *
 * Open Session's session list is built from its own store. Some sessions are
 * real, running work that this server did not create and does not manage:
 * pi and Claude Code sessions started from a terminal on the same host, which
 * register themselves in a local mesh. They are legible and worth showing, but
 * they have no worktree we prepared, no repo we resolved, and no run we can
 * restart.
 *
 * Rather than teach the runner about foreign processes (`docs/extending.md`
 * lists `pi-runner.ts` under "what not to extend"), a provider projects them
 * into the list at the route layer. The precedent is the archived index:
 * `indexedSessions()` already contributes summary rows that are not whole
 * sessions, marked `slim` and hydrated when someone opens one.
 *
 * Invariants:
 *  - A provider never throws into the route. `externalSessionRows()` swallows
 *    failures and contributes nothing, because a dead mesh must not take the
 *    session list down.
 *  - Rows are advisory. They carry `external: true` and `readOnly: true` so
 *    clients can suppress affordances this server cannot honor (archive, PR
 *    creation, worktree operations, deploy).
 *  - Rows are never persisted. See the call site in `routes/sessions.ts`.
 */

/** A projected row for a session this server does not own. */
export type ExternalSessionRow = {
  id: string;
  source: string;
  /** Always true: a projection, not a whole session (same contract as the
   *  archived index — see the `slim` docs on the iOS `Session` model). */
  slim: true;
  /** Owned by another process; this server cannot manage its lifecycle. */
  external: true;
  /** Stage 1 is listing only. Steering arrives with the mesh send path. */
  readOnly: true;
  title?: string;
  repoLess?: boolean;
  worktreeDir?: string;
  isRunning?: boolean;
  runState?: string;
  mode?: string;
  createdAt?: string;
  lastActivity?: string;
  archived?: boolean;
};

export interface ExternalSessionProvider {
  /** Discriminator written to each row's `source` (e.g. "agent-link"). */
  readonly source: string;
  /** Cheap, cached, and must not throw. Called on every list refresh. */
  list(): Promise<ExternalSessionRow[]>;
}

const providers = new Map<string, ExternalSessionProvider>();

export function registerExternalSessionProvider(
  provider: ExternalSessionProvider,
): void {
  providers.set(provider.source, provider);
}

export function unregisterExternalSessionProvider(source: string): void {
  providers.delete(source);
}

export function externalSessionProviderCount(): number {
  return providers.size;
}

/**
 * Every registered provider's rows, flattened. Never throws, never rejects:
 * a provider that fails contributes an empty list and is logged once per
 * failure so a broken mesh is visible without being fatal.
 */
export async function externalSessionRows(): Promise<ExternalSessionRow[]> {
  if (providers.size === 0) return [];
  const settled = await Promise.allSettled(
    [...providers.values()].map((p) => p.list()),
  );
  const rows: ExternalSessionRow[] = [];
  for (const [i, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      rows.push(...result.value);
      continue;
    }
    const source = [...providers.values()][i]?.source ?? "unknown";
    console.warn(
      `[external-sessions] provider ${source} failed:`,
      result.reason,
    );
  }
  return rows;
}
