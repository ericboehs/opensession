export type AskActorRequest =
  | { op: "snapshot"; sessionId: string }
  | { op: "entries" }
  | { op: "set"; sessionId: string; value: unknown }
  | { op: "delete"; sessionId: string }
  | { op: "clear" };

export type AskActorResult<T extends AskActorRequest> = T extends {
  op: "snapshot";
}
  ? unknown | undefined
  : T extends { op: "entries" }
    ? Array<[string, unknown]>
    : T extends { op: "delete" }
      ? boolean
      : void;
