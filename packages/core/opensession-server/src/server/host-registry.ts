/**
 * Registry of agent runs living in detached run-host processes (see
 * src/runner-host/host.ts). The opensession process registers a control handle
 * here for every host it spawned or reattached to; agent-runner's busy/steer/
 * interrupt/cancel helpers consult this alongside their own in-process maps,
 * so callers (WS handlers, session-control MCP, queues) treat hosted runs
 * exactly like in-process ones.
 *
 * Kept import-free of agent-runner/host-client (they both import this) and
 * parked on globalThis so `bun --hot` reloads keep live handles reachable.
 */

export interface HostRunControl {
  hostId: string;
  osSessionId: string;
  /** Whether the run's backend supports mid-run steering (claude yes, codex no). */
  steerable: boolean;
  /** True while the socket to the host is up (steers need a live connection). */
  connected: () => boolean;
  steer: (text: string) => boolean;
  interruptSteer: (text: string) => boolean;
  cancel: () => boolean;
}

// Keyed by every id a caller might know: bks session id, engine session id.
const hostRuns: Map<string, HostRunControl> = ((globalThis as any).__hostRuns ??=
  new Map());

export function registerHostRun(keys: Array<string | undefined>, ctl: HostRunControl): void {
  for (const k of keys) if (k) hostRuns.set(k, ctl);
}

export function addHostRunKey(key: string | undefined, ctl: HostRunControl): void {
  if (key) hostRuns.set(key, ctl);
}

export function unregisterHostRun(ctl: HostRunControl): void {
  for (const [k, v] of hostRuns) {
    if (v === ctl || v.hostId === ctl.hostId) hostRuns.delete(k);
  }
}

export function hostRunBusy(id: string): boolean {
  return hostRuns.has(id);
}

export function hostRunCount(): number {
  return new Set(hostRuns.values()).size;
}

export function hostSteer(id: string, text: string): boolean {
  const ctl = hostRuns.get(id);
  if (!ctl || !ctl.steerable || !ctl.connected()) return false;
  return ctl.steer(text);
}

export function hostInterruptSteer(id: string, text: string): boolean {
  const ctl = hostRuns.get(id);
  if (!ctl || !ctl.steerable || !ctl.connected()) return false;
  return ctl.interruptSteer(text);
}

export function hostCancel(id: string): boolean {
  const ctl = hostRuns.get(id);
  if (!ctl) return false;
  return ctl.cancel();
}
