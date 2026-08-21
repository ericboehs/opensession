import type { GithubCredential } from "../github-auth";
import { createWorkspace, getWorkspace, type Workspace } from "../workspaces";
import type { WorktreeInfo } from "../worktree";
import { registerSessionEffectExecutor } from "./effect-executors";
import { sessionKernel } from "./kernel";
import type { SessionActorEffectFor } from "./lifecycle-protocol";
import type {
  CreationEventDecisionResult,
  DurableOutboxItem,
} from "./store";

type WorkspaceEffect = SessionActorEffectFor<"creation_workspace_prepare">;
type BranchEffect = SessionActorEffectFor<"creation_branch_prepare">;
type CredentialEffect = SessionActorEffectFor<"creation_credential_resolve">;
export type CreationWorkspaceEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> & WorkspaceEffect;
export type CreationBranchEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> & BranchEffect;
export type CreationCredentialEffectItem = Omit<
  DurableOutboxItem,
  "kind" | "payload"
> & CredentialEffect;

export class CreationEffectIndeterminateError extends Error {
  readonly indeterminate = true;
}

type WorkspaceExecutorDependencies = {
  getWorkspace: typeof getWorkspace;
  createWorkspace: typeof createWorkspace;
  result: (item: CreationWorkspaceEffectItem) => CreationEventDecisionResult;
  afterDestinationAccepted?: (workspace: Workspace) => void;
};

function defaultResult(
  item: CreationWorkspaceEffectItem,
): CreationEventDecisionResult {
  return sessionKernel(item.sessionId).applyCreationEvent({
    identity: item.payload.creationIdentity,
    event: "preparation_started",
    effectId: item.effectKey,
    detail: { workspaceId: item.payload.workspaceId },
  });
}

const defaultDependencies: WorkspaceExecutorDependencies = {
  getWorkspace,
  createWorkspace,
  result: defaultResult,
};

function assertAdoptableWorkspace(
  workspace: Workspace,
  item: CreationWorkspaceEffectItem,
): void {
  const payload = item.payload;
  if (workspace.key !== payload.dedupeKey)
    throw new CreationEffectIndeterminateError(
      `Workspace ${payload.workspaceId} exists with another durable identity`,
    );
  if (payload.project !== undefined && workspace.repo !== payload.project)
    throw new CreationEffectIndeterminateError(
      `Workspace ${payload.workspaceId} exists for another project`,
    );
  if (payload.branch !== undefined && workspace.branch !== payload.branch)
    throw new CreationEffectIndeterminateError(
      `Workspace ${payload.workspaceId} exists for another branch`,
    );
  if (
    payload.worktreeDir !== undefined &&
    workspace.worktreeDir !== payload.worktreeDir
  )
    throw new CreationEffectIndeterminateError(
      `Workspace ${payload.workspaceId} exists for another worktree`,
    );
}

/**
 * Create or adopt a fixed workspace destination, then return its fenced result.
 * A retry after destination acceptance adopts the same workspace. A retry after
 * result acceptance receives a stale-result no-op and can safely acknowledge.
 */
export async function executeCreationWorkspacePrepare(
  item: CreationWorkspaceEffectItem,
  dependencies: WorkspaceExecutorDependencies = defaultDependencies,
): Promise<void> {
  const payload = item.payload;
  let workspace = dependencies.getWorkspace(payload.workspaceId);
  if (workspace) assertAdoptableWorkspace(workspace, item);
  else {
    workspace = dependencies.createWorkspace({
      id: payload.workspaceId,
      key: payload.dedupeKey,
      name: payload.name,
      createdBy: payload.createdBy,
      repo: payload.project,
      branch: payload.branch,
      worktreeDir: payload.worktreeDir,
    });
  }
  dependencies.afterDestinationAccepted?.(workspace);
  const result = dependencies.result(item);
  if (result.accepted || result.reason === "stale_effect") return;
  throw new CreationEffectIndeterminateError(
    `Workspace effect ${item.effectId} result was rejected: ${result.reason || "unknown"}`,
  );
}

type BranchExecutorDependencies = {
  listWorktrees: (project: string) => Promise<WorktreeInfo[]>;
  createWorktree: (
    branch: string,
    project: string,
    options: {
      base?: string;
      isolated?: boolean;
      gitEnv?: Record<string, string>;
    },
  ) => Promise<string>;
  resolveCredential?: (principal: string) => Promise<GithubCredential | null>;
  result: (item: CreationBranchEffectItem) => CreationEventDecisionResult;
  afterDestinationAccepted?: (worktreePath: string) => void;
};

function defaultBranchResult(
  item: CreationBranchEffectItem,
): CreationEventDecisionResult {
  return sessionKernel(item.sessionId).applyCreationEvent({
    identity: item.payload.creationIdentity,
    event: "preparation_started",
    effectId: item.effectKey,
    detail: {
      project: item.payload.project,
      branch: item.payload.branch,
      worktreePath: item.payload.worktreePath,
    },
  });
}

async function resolveCurrentCredential(
  principal: string,
): Promise<GithubCredential | null> {
  return (await import("../github-auth")).githubCredentialForPrincipal(principal);
}

const defaultBranchDependencies: BranchExecutorDependencies = {
  listWorktrees: async (project) =>
    (await import("../worktree")).listWorktrees(project),
  createWorktree: async (branch, project, options) =>
    (await import("../worktree")).createWorktree(branch, project, options),
  resolveCredential: resolveCurrentCredential,
  result: defaultBranchResult,
};

/** Create or adopt one exact branch/worktree destination before returning its fence. */
export async function executeCreationBranchPrepare(
  item: CreationBranchEffectItem,
  dependencies: BranchExecutorDependencies = defaultBranchDependencies,
): Promise<void> {
  const payload = item.payload;
  const worktrees = await dependencies.listWorktrees(payload.project);
  const byBranch = worktrees.find((worktree) => worktree.branch === payload.branch);
  const byPath = worktrees.find((worktree) => worktree.path === payload.worktreePath);
  if (byBranch && byBranch.path !== payload.worktreePath)
    throw new CreationEffectIndeterminateError(
      `Branch ${payload.branch} is checked out at another destination`,
    );
  if (byPath && byPath.branch !== payload.branch)
    throw new CreationEffectIndeterminateError(
      `Worktree ${payload.worktreePath} belongs to another branch`,
    );
  let credential: GithubCredential | null = null;
  if (!byBranch && payload.credentialPrincipal) {
    credential = await (dependencies.resolveCredential ??
      resolveCurrentCredential)(payload.credentialPrincipal);
    if (!credential)
      throw new Error(
        `Credential ${payload.credentialPrincipal} is not currently available`,
      );
    if (credential.principal !== payload.credentialPrincipal)
      throw new CreationEffectIndeterminateError(
        `Credential selector ${payload.credentialPrincipal} resolved to another principal`,
      );
  }
  const acceptedPath = byBranch?.path ?? await dependencies.createWorktree(
    payload.branch,
    payload.project,
    {
      ...(payload.baseBranch ? { base: payload.baseBranch } : {}),
      ...(payload.isolated ? { isolated: true } : {}),
      ...(credential ? { gitEnv: credential.env } : {}),
    },
  );
  if (acceptedPath !== payload.worktreePath)
    throw new CreationEffectIndeterminateError(
      `Branch ${payload.branch} materialized at an unexpected destination`,
    );
  dependencies.afterDestinationAccepted?.(acceptedPath);
  const result = dependencies.result(item);
  if (result.accepted || result.reason === "stale_effect") return;
  throw new CreationEffectIndeterminateError(
    `Branch effect ${item.effectId} result was rejected: ${result.reason || "unknown"}`,
  );
}

type CredentialExecutorDependencies = {
  resolveCredential: (principal: string) => Promise<GithubCredential | null>;
  result: (item: CreationCredentialEffectItem) => CreationEventDecisionResult;
  afterResolved?: (credential: GithubCredential) => void;
};

function defaultCredentialResult(
  item: CreationCredentialEffectItem,
): CreationEventDecisionResult {
  return sessionKernel(item.sessionId).applyCreationEvent({
    identity: item.payload.creationIdentity,
    event: "preparation_started",
    effectId: item.effectKey,
    detail: {
      principal: item.payload.principal,
      scope: item.payload.scope,
    },
  });
}

const defaultCredentialDependencies: CredentialExecutorDependencies = {
  resolveCredential: resolveCurrentCredential,
  result: defaultCredentialResult,
};

/** Validate a durable principal selector without returning or persisting its secret. */
export async function executeCreationCredentialResolve(
  item: CreationCredentialEffectItem,
  dependencies: CredentialExecutorDependencies = defaultCredentialDependencies,
): Promise<void> {
  const credential = await dependencies.resolveCredential(item.payload.principal);
  if (!credential)
    throw new Error(
      `Credential ${item.payload.principal} is not currently available`,
    );
  if (credential.principal !== item.payload.principal)
    throw new CreationEffectIndeterminateError(
      `Credential selector ${item.payload.principal} resolved to another principal`,
    );
  dependencies.afterResolved?.(credential);
  const result = dependencies.result(item);
  if (result.accepted || result.reason === "stale_effect") return;
  throw new CreationEffectIndeterminateError(
    `Credential effect ${item.effectId} result was rejected: ${result.reason || "unknown"}`,
  );
}

const registrationGlobal = globalThis as typeof globalThis & {
  __opensessionCreationWorkspaceExecutorRegistered?: boolean;
  __opensessionCreationBranchExecutorRegistered?: boolean;
  __opensessionCreationCredentialExecutorRegistered?: boolean;
};

export function ensureCreationEffectExecutors(): void {
  if (!registrationGlobal.__opensessionCreationWorkspaceExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_workspace_prepare",
      executeCreationWorkspacePrepare,
    );
    registrationGlobal.__opensessionCreationWorkspaceExecutorRegistered = true;
  }
  if (!registrationGlobal.__opensessionCreationBranchExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_branch_prepare",
      executeCreationBranchPrepare,
    );
    registrationGlobal.__opensessionCreationBranchExecutorRegistered = true;
  }
  if (!registrationGlobal.__opensessionCreationCredentialExecutorRegistered) {
    registerSessionEffectExecutor(
      "creation_credential_resolve",
      executeCreationCredentialResolve,
    );
    registrationGlobal.__opensessionCreationCredentialExecutorRegistered = true;
  }
}
