import {
  EXECUTOR_PROVIDER_IDS,
  type ExecutorProvider,
  type ExecutorProviderId,
} from "./provider";

const VALID_PROVIDER_IDS = new Set<string>(EXECUTOR_PROVIDER_IDS);

export class UnknownExecutorProviderError extends Error {
  constructor(providerId: string) {
    super(`unknown or unconfigured Executor provider: ${providerId}`);
    this.name = "UnknownExecutorProviderError";
  }
}

/** Explicit provider registry. It intentionally has no default provider. */
export class ExecutorProviderRegistry {
  readonly #providers = new Map<ExecutorProviderId, ExecutorProvider>();

  register(provider: ExecutorProvider): void {
    if (!VALID_PROVIDER_IDS.has(provider.id)) {
      throw new UnknownExecutorProviderError(String(provider.id));
    }
    if (this.#providers.has(provider.id)) {
      throw new Error(`Executor provider ${provider.id} is already registered`);
    }
    this.#providers.set(provider.id, provider);
  }

  get(providerId: ExecutorProviderId | string): ExecutorProvider {
    if (!VALID_PROVIDER_IDS.has(providerId)) {
      throw new UnknownExecutorProviderError(providerId);
    }
    const provider = this.#providers.get(providerId as ExecutorProviderId);
    if (!provider) throw new UnknownExecutorProviderError(providerId);
    return provider;
  }

  configured(): readonly ExecutorProviderId[] {
    return EXECUTOR_PROVIDER_IDS.filter((id) => this.#providers.has(id));
  }
}
