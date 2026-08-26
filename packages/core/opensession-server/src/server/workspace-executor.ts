import type { ExecutorBroker } from "./executors/broker";
import type {
  ExecutorDispatchRequest,
  ExecutorDispatchResult,
} from "./executors/contract";

/** Target-neutral control-plane facade for structured workspace execution. */
export class WorkspaceExecutor {
  constructor(private readonly broker: ExecutorBroker) {}

  execute(request: ExecutorDispatchRequest): Promise<ExecutorDispatchResult> {
    return this.broker.dispatch(request);
  }
}
