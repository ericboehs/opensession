// Executor replacement owns checkpoint publication, while the portable format
// remains provider-neutral and reusable by every executor.
export {
  InMemoryWorkspaceCheckpointMetadataStore,
  WorkspaceCheckpointStore,
  type WorkspaceCheckpointMetadataStore,
  type WorkspaceCheckpointPublication,
} from "../executors/workspace-delta";
