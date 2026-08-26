import { describe, expect, test } from "bun:test";
import {
	githubAppCreateOwner,
	githubAppCreateUrlForOwner,
	githubAppInstallUrlForSlug,
	shouldReloadAfterGithubAuthEnabled,
} from "./github-app-setup";

describe("GitHub App installation URL", () => {
	test("opens the repository installation picker for the configured App", () => {
		expect(githubAppInstallUrlForSlug(" open-session-9lld ")).toBe(
			"https://github.com/apps/open-session-9lld/installations/new",
		);
		expect(githubAppInstallUrlForSlug(null)).toBeNull();
	});
});

describe("GitHub authentication transition", () => {
	test("reloads only when settings enable the sign-in gate", () => {
		expect(shouldReloadAfterGithubAuthEnabled(false, true)).toBe(true);
		expect(shouldReloadAfterGithubAuthEnabled(true, true)).toBe(false);
		expect(shouldReloadAfterGithubAuthEnabled(true, false)).toBe(false);
		expect(shouldReloadAfterGithubAuthEnabled(false, true, true)).toBe(false);
	});
});

describe("GitHub App creation owner", () => {
	test("reads an organization from a prefilled creation URL", () => {
		expect(githubAppCreateOwner(
			"https://github.com/organizations/acme%20inc/settings/apps/new?name=Open+Session",
		)).toEqual({ type: "organization", login: "acme inc" });
		expect(githubAppCreateOwner(
			"https://github.com/settings/apps/new?name=Open+Session",
		)).toEqual({ type: "personal", login: "" });
	});

	test("switches account level without dropping prefilled App settings", () => {
		const original = "https://github.com/settings/apps/new?name=Open+Session&webhook_url=https%3A%2F%2Fingress.example.test%2Fgithub%2Fwebhook";
		const organization = new URL(
			githubAppCreateUrlForOwner(original, "organization", "acme inc"),
		);
		expect(organization.pathname).toBe(
			"/organizations/acme%20inc/settings/apps/new",
		);
		expect(organization.searchParams.get("name")).toBe("Open Session");
		expect(organization.searchParams.get("webhook_url")).toBe(
			"https://ingress.example.test/github/webhook",
		);

		const personal = new URL(
			githubAppCreateUrlForOwner(organization.toString(), "personal", "ignored"),
		);
		expect(personal.pathname).toBe("/settings/apps/new");
		expect(personal.search).toBe(organization.search);
	});
});
