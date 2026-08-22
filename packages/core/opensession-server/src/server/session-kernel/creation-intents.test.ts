import { describe, expect, test } from "bun:test";
import {
  requestCreationBranch,
  requestCreationCredential,
  requestCreationWorkspace,
} from "./creation-intents";
import {
  SessionKernelStore,
  type CreationEventDecision,
} from "./store";

function harness(sessionId: string) {
  const store = new SessionKernelStore(":memory:");
  return {
    store,
    kernel: {
      creationState: () => store.creationState(sessionId),
      applyCreationEvent: (
        input: Omit<CreationEventDecision, "sessionId">,
      ) => store.applyCreationEvent({ ...input, sessionId }),
    },
  };
}

const input = {
  sessionId: "create-intent",
  identity: "request-intent",
  workspaceId: "ws-create-intent",
  dedupeKey: "session-create:request-intent",
  name: "Creation intent",
  createdBy: "Alice",
  project: "opensession",
  branch: "feature/intent",
  worktreeDir: "/worktrees/intent",
};

const branchInput = {
  sessionId: "create-branch-intent",
  identity: "request-branch-intent",
  project: "opensession",
  branch: "feature/branch-intent",
  worktreePath: "/worktrees/branch-intent",
  baseBranch: "main",
  isolated: true,
  credentialPrincipal: "user:alice",
};

describe("creation workspace intents", () => {
  test("waits for the actor receipt rather than destination evidence", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: input.sessionId,
          identity: input.identity,
          event: "preparation_started",
          effectId: `workspace:${input.workspaceId}`,
        });
      }, 5);
      const state = await requestCreationWorkspace(input, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `workspace:${input.workspaceId}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          effectKey: `workspace:${input.workspaceId}`,
          payload: { worktreeDir: "/worktrees/intent" },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("does not re-emit work after its durable receipt", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      const effectId = `workspace:${input.workspaceId}`;
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "plan",
      });
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "preparation_started",
        nextEffectId: effectId,
        effect: {
          kind: "creation_workspace_prepare",
          effectKey: effectId,
          payload: {
            creationIdentity: input.identity,
            creationGeneration: 1,
            workspaceId: input.workspaceId,
            dedupeKey: input.dedupeKey,
            name: input.name,
            createdBy: input.createdBy,
            project: input.project,
            branch: input.branch,
            worktreeDir: input.worktreeDir,
            mode: "adopt_or_create",
          },
        },
      });
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: input.identity,
        event: "preparation_started",
        effectId,
      });
      const [settled] = store.pendingOutbox();
      store.ackOutbox(settled.id);
      await requestCreationWorkspace(input, { kernel, timeoutMs: 20, pollMs: 1 });
      expect(store.pendingOutbox()).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  test("fails closed on identity crossover", async () => {
    const { store, kernel } = harness(input.sessionId);
    try {
      store.applyCreationEvent({
        sessionId: input.sessionId,
        identity: "another-request",
        event: "plan",
      });
      await expect(
        requestCreationWorkspace(input, { kernel, timeoutMs: 20, pollMs: 1 }),
      ).rejects.toThrow("identity crossed");
    } finally {
      store.close();
    }
  });
});

describe("creation branch intents", () => {
  test("persists stable branch identity and waits for its actor receipt", async () => {
    const { store, kernel } = harness(branchInput.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: branchInput.sessionId,
          identity: branchInput.identity,
          event: "preparation_started",
          effectId: `branch:${branchInput.project}:${branchInput.branch}`,
        });
      }, 5);
      const state = await requestCreationBranch(branchInput, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `branch:${branchInput.project}:${branchInput.branch}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_branch_prepare",
          payload: {
            worktreePath: "/worktrees/branch-intent",
            baseBranch: "main",
            isolated: true,
            credentialPrincipal: "user:alice",
          },
        },
      ]);
    } finally {
      store.close();
    }
  });

  test("normalizes an empty optional base branch before persistence", async () => {
    const input = {
      ...branchInput,
      sessionId: "create-branch-without-base",
      identity: "request-branch-without-base",
      baseBranch: "",
    };
    const { store, kernel } = harness(input.sessionId);
    try {
      await expect(requestCreationBranch(input, {
        kernel,
        timeoutMs: 5,
        pollMs: 1,
      })).rejects.toThrow("remains durably pending");
      expect(store.pendingOutbox()[0]?.payload).not.toHaveProperty("baseBranch");
    } finally {
      store.close();
    }
  });

  test("leaves timed-out branch work durable and does not re-emit it", async () => {
    const { store, kernel } = harness(branchInput.sessionId);
    try {
      await expect(requestCreationBranch(branchInput, {
        kernel,
        timeoutMs: 5,
        pollMs: 1,
      })).rejects.toThrow("remains durably pending");
      expect(store.pendingOutbox()).toHaveLength(1);
      await expect(requestCreationBranch(branchInput, {
        kernel,
        timeoutMs: 5,
        pollMs: 1,
      })).rejects.toThrow("remains durably pending");
      expect(store.pendingOutbox()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe("creation credential intents", () => {
  test("persists only a stable selector and scope before receipt", async () => {
    const input = {
      sessionId: "create-credential-intent",
      identity: "request-credential-intent",
      principal: "user:alice",
      scope: "git:opensession",
    };
    const { store, kernel } = harness(input.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: input.sessionId,
          identity: input.identity,
          event: "preparation_started",
          effectId: `credential:${input.principal}:${input.scope}`,
        });
      }, 5);
      const state = await requestCreationCredential(input, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `credential:${input.principal}:${input.scope}`,
      ]);
      const [effect] = store.pendingOutbox();
      expect(effect).toMatchObject({
        kind: "creation_credential_resolve",
        payload: {
          principal: "user:alice",
          scope: "git:opensession",
        },
      });
      expect(JSON.stringify(effect)).not.toContain("gitEnv");
      expect(JSON.stringify(effect)).not.toContain("token");
    } finally {
      store.close();
    }
  });

  test("continues from a credential receipt to one credential-bound branch", async () => {
    const credential = {
      sessionId: "credential-branch-sequence",
      identity: "request-credential-branch",
      principal: "user:alice",
      scope: "git:opensession",
    };
    const branch = {
      ...branchInput,
      sessionId: credential.sessionId,
      identity: credential.identity,
    };
    const { store, kernel } = harness(credential.sessionId);
    try {
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: credential.sessionId,
          identity: credential.identity,
          event: "preparation_started",
          effectId: `credential:${credential.principal}:${credential.scope}`,
        });
      }, 5);
      await requestCreationCredential(credential, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      const [credentialEffect] = store.pendingOutbox();
      store.ackOutbox(credentialEffect.id);
      setTimeout(() => {
        store.applyCreationEvent({
          sessionId: branch.sessionId,
          identity: branch.identity,
          event: "preparation_started",
          effectId: `branch:${branch.project}:${branch.branch}`,
        });
      }, 5);
      const state = await requestCreationBranch(branch, {
        kernel,
        timeoutMs: 200,
        pollMs: 1,
      });
      expect(state.completedEffectIds).toEqual([
        `credential:${credential.principal}:${credential.scope}`,
        `branch:${branch.project}:${branch.branch}`,
      ]);
      expect(store.pendingOutbox()).toMatchObject([
        {
          kind: "creation_branch_prepare",
          payload: { credentialPrincipal: "user:alice" },
        },
      ]);
    } finally {
      store.close();
    }
  });
});
