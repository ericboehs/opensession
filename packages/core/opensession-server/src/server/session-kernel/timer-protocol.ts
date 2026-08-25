export type TimerActorRequest =
  | {
      op: "begin";
      sessionId: string;
      timerId: string;
      token: string;
    }
  | {
      op: "complete";
      sessionId: string;
      timerId: string;
      token: string;
    }
  | {
      op: "fail";
      sessionId: string;
      timerId: string;
      token: string;
      error: string;
      maxAttempts: number;
    };

export type TimerActorResult<T extends TimerActorRequest> =
  T extends { op: "begin" }
    ? "execute" | "completed" | "missing"
    : T extends { op: "complete" }
      ? boolean
      : T extends { op: "fail" }
        ? { updated: boolean; deadLetteredNow: boolean }
        : never;
