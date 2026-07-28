import { afterEach, describe, expect, test } from "bun:test";
import type { Repo } from "../config";
import type { BackstageSessionFile, UnifiedSession } from "../types";
import type { RouteContext } from "./context";
import {
  handleSessionTransferRoutes,
  importCloudSession,
  transcriptJsonlForTransfer,
  upgradeLocalSession,
} from "./session-transfer";

const SESSION_ID = "bks-019f8a5b-c122-7000-aebd-3cf01eb664ca";

function repo(id = "local-repo", ghRepo = "acme/widget"): Repo {
  return {
    id,
    label: id,
    repo: `/repos/${id}`,
    wtPrefix: id,
    defaultBranch: "main",
    ghRepo,
  };
}

function session(): UnifiedSession {
  return {
    id: SESSION_ID,
    claudeSessionId: "ses_local",
    opencodeSessionId: "ses_local",
    source: "backstage",
    branch: "feature/local-work",
    worktreeDir: "/worktrees/local-work",
    startedBy: "Ada",
    title: "Local work",
    lastActivity: "2026-07-22T10:05:00.000Z",
    createdAt: "2026-07-22T10:00:00.000Z",
    isRunning: false,
    transcriptPath: "/transcripts/ses_local.jsonl",
    mode: "code",
    repo: "local-repo",
    model: "opencode/anthropic/claude-sonnet-5",
  };
}

function sessionFile(): BackstageSessionFile {
  return {
    id: SESSION_ID,
    claudeSessionId: "ses_local",
    opencodeSessionId: "ses_local",
    branch: "feature/local-work",
    worktreeDir: "/worktrees/local-work",
    repo: "local-repo",
    createdBy: "Ada",
    createdAt: "2026-07-22T10:00:00.000Z",
    lastActivity: "2026-07-22T10:05:00.000Z",
    title: "Local work",
    mode: "code",
    model: "opencode/anthropic/claude-sonnet-5",
  };
}

function importBody(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      id: SESSION_ID,
      createdBy: "Ada",
      createdAt: "2026-07-22T10:00:00.000Z",
      lastActivity: "2026-07-22T10:05:00.000Z",
      title: "Local work",
      mode: "code",
      model: "opencode/anthropic/claude-sonnet-5",
    },
    transcriptFormat: "transcript-v2-jsonl",
    transcriptJsonl:
      '{"id":"u1","type":"user","content":"Continue this","timestamp":"2026-07-22T10:01:00.000Z"}\n',
    repo: "cloud-repo",
    branch: "feature/local-work",
    ...overrides,
  };
}

function importDeps(overrides: Record<string, unknown> = {}) {
  return {
    repos: () => ({ "cloud-repo": repo("cloud-repo") }),
    sessionExists: () => false,
    branchExists: async () => true,
    createWorktree: async () => "/cloud/worktrees/local-work",
    verifyWorktree: async () => {},
    importTranscript: () => {},
    removeTranscript: () => {},
    writeSession: () => {},
    sessionUrl: (id: string) => `https://cloud.example/session/${id}`,
    ...overrides,
  } as any;
}

function upgradeDeps(overrides: Record<string, unknown> = {}) {
  return {
    repos: () => ({ "local-repo": repo() }),
    findSession: () => session(),
    readSession: () => sessionFile(),
    isBusy: () => false,
    hasQueuedPrompts: () => false,
    reserve: () => {},
    release: () => {},
    gitState: async () => ({
      branch: "feature/local-work",
      uncommittedFiles: [],
    }),
    push: async () => ({ ok: true as const }),
    readTranscript: () =>
      '{"id":"u1","type":"user","content":"Continue this","timestamp":"2026-07-22T10:01:00.000Z"}\n',
    cloud: () => ({ upstream: "https://cloud.example", token: "secret" }),
    fetch: (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch,
    archive: () => {},
    ...overrides,
  } as any;
}

describe("cloud session import", () => {
  test("validates ids, registered repos, branches, and transcript JSONL", async () => {
    const badId = await importCloudSession(
      importBody({ session: { id: "../../sessions" } }),
      { login: "ada", name: "Ada Lovelace" },
      importDeps(),
    );
    expect(badId.status).toBe(400);
    expect((await badId.json()).error).toContain("UUIDv7");

    const missingRepo = await importCloudSession(
      importBody({ repo: "missing" }),
      null,
      importDeps(),
    );
    expect(missingRepo.status).toBe(400);
    expect((await missingRepo.json()).error).toContain("not registered");

    const missingBranch = await importCloudSession(
      importBody(),
      null,
      importDeps({ branchExists: async () => false }),
    );
    expect(missingBranch.status).toBe(400);
    expect((await missingBranch.json()).error).toContain("does not exist on origin");

    const badTranscript = await importCloudSession(
      importBody({ transcriptJsonl: "not-json\n" }),
      null,
      importDeps(),
    );
    expect(badTranscript.status).toBe(400);
    expect((await badTranscript.json()).error).toContain("line 1");

    const unsupportedTranscript = await importCloudSession(
      importBody({ transcriptJsonl: '{"type":"user","uuid":"u1"}\n' }),
      null,
      importDeps(),
    );
    expect(unsupportedTranscript.status).toBe(400);
    expect((await unsupportedTranscript.json()).error).toContain("transcript-v2");

    const unknownFormat = await importCloudSession(
      importBody({ transcriptFormat: "future-v3" }),
      null,
      importDeps(),
    );
    expect(unknownFormat.status).toBe(400);
    expect((await unknownFormat.json()).error).toContain("transcriptFormat");
  });

  test("accepts the original unversioned Claude-shape JSONL contract", async () => {
    let entries: unknown[] = [];
    const response = await importCloudSession(
      importBody({
        transcriptFormat: undefined,
        transcriptJsonl:
          '{"type":"user","uuid":"u1","timestamp":"2026-07-22T10:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"Continue this"}]}}\n',
      }),
      null,
      importDeps({
        importTranscript: (_id: string, imported: unknown[]) => {
          entries = imported;
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(entries).toEqual([
      expect.objectContaining({ id: "u1", type: "user", content: "Continue this" }),
    ]);
  });

  test("returns 409 without side effects when the id already exists", async () => {
    let created = false;
    const response = await importCloudSession(
      importBody(),
      null,
      importDeps({
        sessionExists: () => true,
        createWorktree: async () => {
          created = true;
          return "/never";
        },
      }),
    );
    expect(response.status).toBe(409);
    expect(created).toBe(false);
  });

  test("cleans up a partial transcript-v2 import and returns JSON", async () => {
    let removed = false;
    const response = await importCloudSession(
      importBody(),
      null,
      importDeps({
        importTranscript: () => {
          throw new Error("transcript store unavailable");
        },
        removeTranscript: (id: string) => {
          expect(id).toBe(SESSION_ID);
          removed = true;
        },
      }),
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      error: "transcript store unavailable",
    });
    expect(removed).toBe(true);
  });

  test("creates the existing-branch worktree and imports history into transcript v2", async () => {
    const calls: string[] = [];
    let persisted: any;
    let transcript: { id: string; entries: unknown[] } | undefined;
    const response = await importCloudSession(
      importBody(),
      { login: "ada", name: "Ada Lovelace" },
      importDeps({
        createWorktree: async (branch: string, repoId: string) => {
          calls.push(`worktree:${repoId}:${branch}`);
          return "/cloud/worktrees/local-work";
        },
        importTranscript: (id: string, entries: unknown[]) => {
          calls.push("transcript");
          transcript = { id, entries };
        },
        writeSession: (_id: string, data: unknown) => {
          calls.push("session");
          persisted = data;
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      id: SESSION_ID,
      url: `https://cloud.example/session/${SESSION_ID}`,
    });
    expect(calls).toEqual([
      "worktree:cloud-repo:feature/local-work",
      "transcript",
      "session",
    ]);
    expect(transcript?.id).toBe(SESSION_ID);
    expect(transcript?.entries).toEqual([
      expect.objectContaining({
        id: "u1",
        type: "user",
        content: "Continue this",
      }),
    ]);
    expect(persisted).toMatchObject({
      id: SESSION_ID,
      claudeSessionId: "ses_import_019f8a5bc1227000aebd3cf01eb664ca",
      opencodeSessionId: "ses_import_019f8a5bc1227000aebd3cf01eb664ca",
      repo: "cloud-repo",
      branch: "feature/local-work",
      worktreeDir: "/cloud/worktrees/local-work",
      createdByLogin: "ada",
      importedFrom: "local",
      mode: "code",
    });
    expect(persisted).not.toHaveProperty("accountId");
    expect(persisted).not.toHaveProperty("automation");
  });

  test("serializes full hydrated transcript-v2 entries without derived seqs", () => {
    const jsonl = transcriptJsonlForTransfer([
      {
        id: "u1",
        type: "user",
        content: "Continue this",
        timestamp: "2026-07-22T10:01:00.000Z",
        seq: 1,
      } as any,
      {
        id: "a1",
        type: "assistant",
        content: "I remember.",
        timestamp: "2026-07-22T10:01:01.000Z",
        model: "opencode/anthropic/claude-sonnet-5",
        videos: ["/backstage/media/demo.mp4"],
      },
      {
        id: "notice-1",
        type: "system",
        content: "Runner switched accounts",
        timestamp: "2026-07-22T10:01:02.000Z",
      },
    ]);

    expect(jsonl.endsWith("\n")).toBe(true);
    expect(jsonl.split("\n").filter(Boolean).map((line) => JSON.parse(line))).toEqual([
      {
        id: "u1",
        type: "user",
        content: "Continue this",
        timestamp: "2026-07-22T10:01:00.000Z",
      },
      expect.objectContaining({
        id: "a1",
        type: "assistant",
        videos: ["/backstage/media/demo.mp4"],
      }),
      expect.objectContaining({ id: "notice-1", type: "system" }),
    ]);
  });
});

describe("local session upgrade", () => {
  test("allows only one in-flight upgrade for a session", async () => {
    let resolveRepos: ((response: Response) => void) | undefined;
    const reposResponse = new Promise<Response>((resolve) => {
      resolveRepos = resolve;
    });
    const first = upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        fetch: (async () => reposResponse) as unknown as typeof fetch,
      }),
    );

    const second = await upgradeLocalSession(SESSION_ID, upgradeDeps());
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("already in progress");

    resolveRepos?.(new Response(null, { status: 502 }));
    expect((await first).status).toBe(502);

    const retry = await upgradeLocalSession(SESSION_ID, upgradeDeps());
    expect(retry.status).not.toBe(409);
  });

  test("rejects an existing prompt queue before reserving the transfer", async () => {
    let pushed = false;
    const response = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        hasQueuedPrompts: () => true,
        push: async () => {
          pushed = true;
          return { ok: true };
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("queued prompts");
    expect(pushed).toBe(false);
  });

  test("rejects attached repositories before reserving the transfer", async () => {
    let reserved = false;
    const response = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        findSession: () => ({
          ...session(),
          attachedRepos: [
            {
              repo: "docs",
              branch: "feature/local-work",
              dir: "/worktrees/docs",
            },
          ],
        }),
        reserve: () => {
          reserved = true;
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("attached repositories");
    expect(reserved).toBe(false);
  });

  test("rejects dirty worktrees with the file list before pushing", async () => {
    let pushed = false;
    const response = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        gitState: async () => ({
          branch: "feature/local-work",
          uncommittedFiles: ["src/index.ts", "new.txt"],
        }),
        push: async () => {
          pushed = true;
          return { ok: true };
        },
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      uncommittedFiles: ["src/index.ts", "new.txt"],
    });
    expect(pushed).toBe(false);
  });

  test("maps ghRepo, pushes, imports with Bearer auth, then archives", async () => {
    const calls: string[] = [];
    let importPayload: any;
    let archived: any;
    const fetchMock = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/backstage/api/repos")) {
        calls.push("repos");
        expect((init?.headers as Record<string, string>).authorization).toBe(
          "Bearer secret",
        );
        return Response.json({
          repos: [{ id: "different-cloud-id", ghRepo: "ACME/widget.git" }],
        });
      }
      calls.push("import");
      importPayload = JSON.parse(String(init?.body));
      return Response.json({
        id: SESSION_ID,
        url: `https://cloud.example/session/${SESSION_ID}`,
      }, { status: 201 });
    }) as typeof fetch;

    const response = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        fetch: fetchMock,
        push: async () => {
          calls.push("push");
          return { ok: true };
        },
        archive: (_id: string, _data: unknown, destination: unknown) => {
          calls.push("archive");
          archived = destination;
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toEqual(["repos", "push", "import", "archive"]);
    expect(importPayload).toMatchObject({
      repo: "different-cloud-id",
      branch: "feature/local-work",
      transcriptFormat: "transcript-v2-jsonl",
      transcriptJsonl:
        '{"id":"u1","type":"user","content":"Continue this","timestamp":"2026-07-22T10:01:00.000Z"}\n',
      session: {
        id: SESSION_ID,
        title: "Local work",
        createdBy: "Ada",
      },
    });
    expect(importPayload.session).not.toHaveProperty("worktreeDir");
    expect(importPayload.session).not.toHaveProperty("opencodeSessionId");
    expect(archived).toEqual({
      id: SESSION_ID,
      url: `https://cloud.example/session/${SESSION_ID}`,
    });
  });

  test("passes through an import error and leaves the local session untouched", async () => {
    let archived = false;
    const fetchMock = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/backstage/api/repos")) {
        return Response.json({
          repos: [{ id: "cloud-repo", ghRepo: "acme/widget" }],
        });
      }
      return Response.json({ error: "Branch vanished" }, { status: 422 });
    }) as typeof fetch;
    const response = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        fetch: fetchMock,
        archive: () => {
          archived = true;
        },
      }),
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "Branch vanished" });
    expect(archived).toBe(false);
  });

  test("turns empty upstream failures into diagnostic JSON", async () => {
    const reposFailure = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        fetch: (async () =>
          new Response(null, { status: 502 })) as unknown as typeof fetch,
      }),
    );
    expect(reposFailure.status).toBe(502);
    expect(reposFailure.headers.get("content-type")).toContain("application/json");
    expect(await reposFailure.json()).toEqual({
      error: "Cloud OpenSession returned HTTP 502",
    });

    const importFailure = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        fetch: (async (input: string | URL | Request) =>
          String(input).endsWith("/backstage/api/repos")
            ? Response.json({
                repos: [{ id: "cloud-repo", ghRepo: "acme/widget" }],
              })
            : new Response(null, { status: 502 })) as typeof fetch,
      }),
    );
    expect(importFailure.status).toBe(502);
    expect(importFailure.headers.get("content-type")).toContain("application/json");
    expect(await importFailure.json()).toEqual({
      error: "Cloud OpenSession returned HTTP 502",
    });

    const messageFailure = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        fetch: (async (input: string | URL | Request) =>
          String(input).endsWith("/backstage/api/repos")
            ? Response.json({ message: "temporarily unavailable" }, { status: 502 })
            : new Response()) as typeof fetch,
      }),
    );
    expect(await messageFailure.json()).toMatchObject({
      error: "temporarily unavailable",
      message: "temporarily unavailable",
    });
  });

  test("recovers when cloud import succeeded before the local archive write", async () => {
    let archived: unknown;
    const fetchMock = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/backstage/api/repos")) {
        return Response.json({
          repos: [{ id: "cloud-repo", ghRepo: "acme/widget" }],
        });
      }
      if (url.endsWith("/backstage/api/sessions/import")) {
        return Response.json({ error: "Session already exists" }, { status: 409 });
      }
      return Response.json([
        {
          id: SESSION_ID,
          importedFrom: "local",
          repo: "cloud-repo",
          branch: "feature/local-work",
        },
      ]);
    }) as typeof fetch;
    const response = await upgradeLocalSession(
      SESSION_ID,
      upgradeDeps({
        fetch: fetchMock,
        archive: (_id: string, _data: unknown, destination: unknown) => {
          archived = destination;
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(archived).toEqual({
      id: SESSION_ID,
      url: `https://cloud.example/session/${SESSION_ID}`,
    });
  });
});

const savedProfile = process.env.OPENSESSION_PROFILE;
afterEach(() => {
  if (savedProfile === undefined) delete process.env.OPENSESSION_PROFILE;
  else process.env.OPENSESSION_PROFILE = savedProfile;
});

test("the upgrade route is dormant outside the local profile", async () => {
  process.env.OPENSESSION_PROFILE = "cloud";
  const path = `/backstage/api/sessions/${SESSION_ID}/upgrade`;
  const req = new Request(`http://127.0.0.1:3850${path}`, { method: "POST" });
  const ctx: RouteContext = {
    req,
    url: new URL(req.url),
    path,
    publicPrefix: "",
    authUser: null,
  };
  expect(await handleSessionTransferRoutes(ctx)).toBeUndefined();
});
