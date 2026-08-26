export interface SessionStateEvent {
  sessionId: string;
  isRunning: boolean;
  at: number;
}

type SessionStateListener = (event: SessionStateEvent) => void;

const g = globalThis as {
  __osSessionStateListeners?: Set<SessionStateListener>;
};

function listeners(): Set<SessionStateListener> {
  return (g.__osSessionStateListeners ??= new Set());
}

export function onSessionStateChange(
  listener: SessionStateListener,
): () => void {
  listeners().add(listener);
  return () => listeners().delete(listener);
}

export function emitSessionStateChange(event: SessionStateEvent): void {
  for (const listener of listeners()) {
    try {
      listener(event);
    } catch (error) {
      console.error("[live-activities] session-state listener failed:", error);
    }
  }
}
