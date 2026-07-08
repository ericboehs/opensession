/**
 * Sandbox provider registry (Phase 0 of docs/sandboxes-plan.md).
 *
 * `getSandboxProvider()` resolves the provider for a run: an explicit spec
 * wins, otherwise the config file (~/.backstage-sandbox.json) decides, and the
 * kill-switch file (~/.backstage-chats/disable-sandboxes) forces "local".
 * Only the local provider exists today — docker (Phase 1) and daytona/e2b
 * (Phase 3) throw until their adapters land, so a premature config flip fails
 * loudly at run start instead of silently running unsandboxed.
 */

import { LocalProvider } from "./local";
import { DockerProvider } from "./docker";
import { effectiveSandboxProvider } from "./config";
import type { SandboxProvider, SandboxProviderId } from "./provider";

export type {
  Sandbox,
  SandboxProvider,
  SandboxProviderId,
  SandboxSessionSpec,
  SandboxStatus,
  ExecOpts,
  ExecResult,
  PortMap,
  RunHandle,
  RunHandleCallbacks,
} from "./provider";
export {
  sandboxConfig,
  sandboxesEnabled,
  effectiveSandboxProvider,
  type SandboxConfig,
  type SandboxWorkspaceMode,
} from "./config";
export {
  workspaceExecFor,
  hostWorkspaceExec,
  hasRemoteWorkspace,
  type WorkspaceExec,
  type WorkspaceExecSession,
} from "./workspace-exec";
export { LocalProvider } from "./local";

// Shared instances — both providers keep their state on disk/docker, not here.
const localProvider = new LocalProvider();
const dockerProvider = new DockerProvider();

/**
 * Resolve a SandboxProvider. `spec` (a provider id, e.g. from a session file's
 * `sandbox.provider`) overrides the config; omitted = effective config value.
 */
export function getSandboxProvider(
  spec?: SandboxProviderId | string,
): SandboxProvider {
  const id = (spec as SandboxProviderId) || effectiveSandboxProvider();
  switch (id) {
    case "local":
      return localProvider;
    case "docker":
      return dockerProvider;
    case "daytona":
    case "e2b":
      throw new Error(
        `sandbox provider "${id}" is not yet wired — only "local" and "docker" exist (see docs/sandboxes-plan.md)`,
      );
    default:
      throw new Error(`unknown sandbox provider "${id}"`);
  }
}
