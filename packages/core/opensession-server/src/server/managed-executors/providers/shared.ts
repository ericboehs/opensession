import type {
  EnsuredExecutor,
  ExecutorProviderId,
  ExecutorResourceRef,
} from "../provider";

export const EXECUTOR_METADATA_KEYS = {
  kind: "opensession.resource-kind",
  provider: "opensession.executor-provider",
  executorId: "opensession.executor-id",
  sessionId: "opensession.session-id",
  generation: "opensession.executor-generation",
} as const;

export const EXECUTOR_RESOURCE_KIND = "executor";

export type ExecutorMetadata = Readonly<Record<string, string>>;

export interface ProviderResource {
  id: string;
  workspaceId: string;
  metadata: ExecutorMetadata;
}

/** The sole command-capable dependency accepted by a lifecycle adapter. */
export type InstallExecutor<Resource> = (
  resource: Resource,
  identity: Readonly<{
    executorId: string;
    sessionId: string;
    generation: number;
  }>,
) => Promise<EnsuredExecutor>;

export function executorMetadata(
  provider: ExecutorProviderId,
  identity: Readonly<{
    executorId: string;
    sessionId: string;
    generation: number;
  }>,
): Record<string, string> {
  assertIdentity(identity.executorId, "executorId");
  assertIdentity(identity.sessionId, "sessionId");
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new TypeError("generation must be a positive safe integer");
  }
  return {
    [EXECUTOR_METADATA_KEYS.kind]: EXECUTOR_RESOURCE_KIND,
    [EXECUTOR_METADATA_KEYS.provider]: provider,
    [EXECUTOR_METADATA_KEYS.executorId]: identity.executorId,
    [EXECUTOR_METADATA_KEYS.sessionId]: identity.sessionId,
    [EXECUTOR_METADATA_KEYS.generation]: String(identity.generation),
  };
}

export function managedResourceRef(
  provider: ExecutorProviderId,
  resource: Pick<ProviderResource, "id" | "metadata">,
): ExecutorResourceRef | undefined {
  const metadata = resource.metadata;
  if (
    metadata[EXECUTOR_METADATA_KEYS.kind] !== EXECUTOR_RESOURCE_KIND ||
    metadata[EXECUTOR_METADATA_KEYS.provider] !== provider
  ) {
    return undefined;
  }
  const executorId = metadata[EXECUTOR_METADATA_KEYS.executorId];
  const sessionId = metadata[EXECUTOR_METADATA_KEYS.sessionId];
  const generationText = metadata[EXECUTOR_METADATA_KEYS.generation];
  if (!executorId?.trim() || !sessionId?.trim() || !generationText) {
    return undefined;
  }
  const generation = Number(generationText);
  if (!Number.isSafeInteger(generation) || generation < 1) return undefined;
  return { resourceId: resource.id, executorId, sessionId, generation };
}

export function assertResourceIdentity(
  provider: ExecutorProviderId,
  resource: Pick<ProviderResource, "id" | "metadata">,
  expected: ExecutorResourceRef,
): void {
  const actual = managedResourceRef(provider, resource);
  if (
    !actual ||
    actual.resourceId !== expected.resourceId ||
    actual.executorId !== expected.executorId ||
    actual.sessionId !== expected.sessionId ||
    actual.generation !== expected.generation
  ) {
    throw new Error(
      `Executor identity mismatch for provider resource ${expected.resourceId}`,
    );
  }
}

export function assertInstalledIdentity(
  installed: EnsuredExecutor,
  expectedExecutorId: string,
): EnsuredExecutor {
  if (installed.executorId !== expectedExecutorId) {
    throw new Error("installer returned the wrong Executor identity");
  }
  if (!installed.workspaceId.trim()) {
    throw new Error("installer returned an invalid workspace identity");
  }
  return installed;
}

export function assertCreatedResource(
  provider: ExecutorProviderId,
  resource: ProviderResource,
  identity: Readonly<{
    executorId: string;
    sessionId: string;
    generation: number;
  }>,
): void {
  if (!resource.id.trim() || !resource.workspaceId.trim()) {
    throw new Error("provider returned an invalid Executor resource");
  }
  assertResourceIdentity(provider, resource, {
    resourceId: resource.id,
    executorId: identity.executorId,
    sessionId: identity.sessionId,
    generation: identity.generation,
  });
}

function assertIdentity(value: string, name: string): void {
  if (!value.trim()) throw new TypeError(`${name} is required`);
}
