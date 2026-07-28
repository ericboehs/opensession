import { describe, expect, test } from "bun:test";
import { sessionPrBranch } from "./session-pr-target";
import type { UnifiedSession } from "./types";
import type { Workspace } from "./workspaces";

const session = {
	id: "bks-ghpr-5286-review",
	branch: "add-lottie-primitive-os-review",
	automation: "github-pr-review",
} as UnifiedSession;

const workspace = {
	id: "prj-review",
	name: "#5286 Add Lottie timeline primitive",
	createdBy: "GitHub (automation)",
	createdAt: "2026-07-28T00:00:00.000Z",
	prNumber: 5286,
	branch: "add-lottie-primitive",
} as Workspace;

describe("sessionPrBranch", () => {
	test("uses the PR workspace branch for a GitHub review checkout", () => {
		expect(sessionPrBranch(session, workspace)).toBe("add-lottie-primitive");
	});

	test("does not rewrite ordinary session branches", () => {
		expect(
			sessionPrBranch(
				{ ...session, automation: undefined } as UnifiedSession,
				workspace,
			),
		).toBe("add-lottie-primitive-os-review");
	});

	test("requires a structurally PR-backed workspace", () => {
		expect(
			sessionPrBranch(session, { ...workspace, prNumber: undefined }),
		).toBe("add-lottie-primitive-os-review");
	});
});
