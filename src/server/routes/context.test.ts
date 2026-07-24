import { afterEach, describe, expect, test } from "bun:test";
import { setLocalProfileIdentity } from "../profile";
import { requestUser, type RouteContext } from "./context";

const savedProfile = process.env.OPENSESSION_PROFILE;

afterEach(() => {
	setLocalProfileIdentity(null);
	if (savedProfile === undefined) delete process.env.OPENSESSION_PROFILE;
	else process.env.OPENSESSION_PROFILE = savedProfile;
});

describe("request user attribution", () => {
	test("uses the request-scoped verified identity in local mode", () => {
		process.env.OPENSESSION_PROFILE = "local";
		setLocalProfileIdentity({ login: "other", name: "Other Person" });
		const ctx = {
			authUser: { login: "ada", name: "Ada Lovelace" },
		} as RouteContext;

		expect(requestUser(ctx, "Claimed")).toBe("Ada");
	});
});
