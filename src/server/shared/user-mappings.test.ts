import { describe, test, expect } from "bun:test";
import {
  deriveIdentityTables,
  GITHUB_TO_SLACK,
  LINEAR_EMAIL_TO_GITHUB,
  SLACK_ID_TO_NAME,
  gitIdentityFor,
  resolveTeammate,
  githubLoginFor,
  githubLoginToPersonKey,
	githubLoginToPersonKeyFromTeam,
  githubUsernameToSlackId,
  linearEmailToGithubUsername,
	personKeyToDisplayName,
  slackIdToFirstName,
  userMatchesAny,
} from "./user-mappings";
import { configuredIdentity, type TeamMember } from "../config";

// The historical hardcoded tables (pre-config literals, verbatim). The
// config-driven derivation must reproduce these EXACTLY from the equivalent
// identity config — this is the behavior-identity contract for audit item 1f.
const EXPECTED_GITHUB_TO_SLACK = {
  happylinks: "UT41L6GCC",
  johnnylinsf: "U0866D7PCCU",
  "9ranty": "USU9S2YRF",
  thiblahute: "U065GD4757C",
  jfrolich: "U08EWERLX8D",
  soutar: "U08CXTV7ML2",
  kentdebruin: "U08S8B3P83X",
};

const EXPECTED_LINEAR_EMAIL_TO_GITHUB = {
  "michiel@tella.tv": "happylinks",
  "grant@tella.tv": "9ranty",
  "johnny@tella.tv": "johnnylinsf",
  "kent@tella.com": "kentdebruin",
  "john@tella.com": "soutar",
  "jaap@tella.com": "jfrolich",
  "louise@tella.com": "louisedesadeleer",
  "tsaunier@igalia.com": "thiblahute",
};

const EXPECTED_SLACK_ID_TO_NAME = {
  UT41L6GCC: "Michiel Westerbeek",
  U0866D7PCCU: "Johnny Lin",
  USU9S2YRF: "Grant Shaddick",
  U065GD4757C: "Thibault Saunier",
  U066K2VRDHA: "Andres Gomez",
  U08CXTV7ML2: "John Soutar",
  U08EWERLX8D: "Jaap Frolich",
  U08JGAT5KNK: "Louise de Sadeleer",
  U08S8B3P83X: "Kent de Bruin",
  U0A3CERFC57: "Connor",
  U0A3PB2MJET: "Ankita Kulkarni",
  U0A7T08405R: "Michael",
  U03EACNTLA1: "Linear",
  U01D3KX3ATW: "Johnny",
  U01E8UE6L15: "Louise",
  U084XSXRQNB: "Kent",
  U086HCZURPM: "Grant",
};

const EXPECTED_TEAM_GIT_IDENTITY = [
  { name: "Michiel Westerbeek", email: "happylinks@gmail.com", aliases: ["michiel"], slackId: "UT41L6GCC", github: "happylinks" },
  { name: "Jaap Frolich", email: "jfrolich@gmail.com", aliases: ["jaap"], slackId: "U08EWERLX8D", github: "jfrolich" },
  { name: "Kent de Bruin", email: "52224550+kentdebruin@users.noreply.github.com", aliases: ["kent"], slackId: "U08S8B3P83X", github: "kentdebruin" },
  { name: "Grant Shaddick", email: "grant@tella.com", aliases: ["grant"], slackId: "USU9S2YRF", github: "9ranty" },
  { name: "Johnny Lin", email: "67078496+johnnylinsf@users.noreply.github.com", aliases: ["johnny"], slackId: "U0866D7PCCU", github: "johnnylinsf" },
  { name: "John Soutar", email: "john@tella.com", aliases: ["john"], slackId: "U08CXTV7ML2", github: "soutar" },
  { name: "Louise de Sadeleer", email: "54376811+louisedesadeleer@users.noreply.github.com", aliases: ["louise"], slackId: "U08JGAT5KNK", github: "louisedesadeleer" },
  { name: "Thibault Saunier", email: "tsaunier@igalia.com", aliases: ["thibault"], slackId: "U065GD4757C", github: "thiblahute" },
];

// The equivalent config JSON: the same roster expressed as identity.team +
// identity.slackNames (what a self-hoster would write in config.json). This is
// also byte-identical to config.ts's built-in DEFAULT_TEAM/DEFAULT_SLACK_NAMES.
const EQUIVALENT_TEAM: TeamMember[] = [
  { name: "Michiel Westerbeek", email: "happylinks@gmail.com", aliases: ["michiel"], slackId: "UT41L6GCC", github: "happylinks", linearEmails: ["michiel@tella.tv"] },
  { name: "Jaap Frolich", email: "jfrolich@gmail.com", aliases: ["jaap"], slackId: "U08EWERLX8D", github: "jfrolich", linearEmails: ["jaap@tella.com"] },
  { name: "Kent de Bruin", email: "52224550+kentdebruin@users.noreply.github.com", aliases: ["kent"], slackId: "U08S8B3P83X", github: "kentdebruin", linearEmails: ["kent@tella.com"] },
  { name: "Grant Shaddick", email: "grant@tella.com", aliases: ["grant"], slackId: "USU9S2YRF", github: "9ranty", linearEmails: ["grant@tella.tv"] },
  { name: "Johnny Lin", email: "67078496+johnnylinsf@users.noreply.github.com", aliases: ["johnny"], slackId: "U0866D7PCCU", github: "johnnylinsf", linearEmails: ["johnny@tella.tv"] },
  { name: "John Soutar", email: "john@tella.com", aliases: ["john"], slackId: "U08CXTV7ML2", github: "soutar", linearEmails: ["john@tella.com"] },
  // githubToSlack: false — the historical GITHUB_TO_SLACK never listed Louise.
  { name: "Louise de Sadeleer", email: "54376811+louisedesadeleer@users.noreply.github.com", aliases: ["louise"], slackId: "U08JGAT5KNK", github: "louisedesadeleer", linearEmails: ["louise@tella.com"], githubToSlack: false },
  { name: "Thibault Saunier", email: "tsaunier@igalia.com", aliases: ["thibault"], slackId: "U065GD4757C", github: "thiblahute", linearEmails: ["tsaunier@igalia.com"] },
];

const EQUIVALENT_SLACK_NAMES: Record<string, string> = {
  U066K2VRDHA: "Andres Gomez",
  U0A3CERFC57: "Connor",
  U0A3PB2MJET: "Ankita Kulkarni",
  U0A7T08405R: "Michael",
  U03EACNTLA1: "Linear",
  U01D3KX3ATW: "Johnny",
  U01E8UE6L15: "Louise",
  U084XSXRQNB: "Kent",
  U086HCZURPM: "Grant",
};

describe("identity table derivation (audit 1f)", () => {
  test("derivation from the equivalent config reproduces the historical tables exactly", () => {
    const t = deriveIdentityTables(EQUIVALENT_TEAM, EQUIVALENT_SLACK_NAMES);
    expect(t.githubToSlack).toEqual(EXPECTED_GITHUB_TO_SLACK);
    expect(t.linearEmailToGithub).toEqual(EXPECTED_LINEAR_EMAIL_TO_GITHUB);
    expect(t.slackIdToName).toEqual(EXPECTED_SLACK_ID_TO_NAME);
    expect(t.teamGitIdentity).toEqual(EXPECTED_TEAM_GIT_IDENTITY);
  });

  test("zero-config module exports equal the historical tables", () => {
    // No config file on this host / in CI → configuredIdentity() built-ins.
    expect(GITHUB_TO_SLACK).toEqual(EXPECTED_GITHUB_TO_SLACK);
    expect(LINEAR_EMAIL_TO_GITHUB).toEqual(EXPECTED_LINEAR_EMAIL_TO_GITHUB);
    expect(SLACK_ID_TO_NAME).toEqual(EXPECTED_SLACK_ID_TO_NAME);
    // …and the built-in default roster IS the equivalent config.
    const identity = configuredIdentity();
    const t = deriveIdentityTables(identity.team, identity.slackNames);
    expect(t.teamGitIdentity).toEqual(EXPECTED_TEAM_GIT_IDENTITY);
  });

  test("resolver behavior is unchanged for the default roster", () => {
    expect(gitIdentityFor("kent")).toEqual({
      name: "Kent de Bruin",
      email: "52224550+kentdebruin@users.noreply.github.com",
    });
    expect(gitIdentityFor("U08S8B3P83X")?.name).toBe("Kent de Bruin");
    expect(gitIdentityFor("grant@tella.tv")?.name).toBe("Grant Shaddick");
    expect(gitIdentityFor("9ranty")?.name).toBe("Grant Shaddick");
    expect(gitIdentityFor("anonymous")).toBeNull();
    expect(gitIdentityFor("Kent (loop)")?.name).toBe("Kent de Bruin");
    expect(resolveTeammate("louise")).toEqual({ slackId: "U08JGAT5KNK", name: "Louise de Sadeleer" });
    expect(resolveTeammate("nobody-known")).toBeNull();
    expect(githubLoginFor("michiel")).toBe("happylinks");
    expect(githubLoginToPersonKey("kentdebruin")).toBe("kent");
		expect(
			githubLoginToPersonKeyFromTeam("ada", [
				{ name: "Ada Lovelace", aliases: ["ada"], github: "ada" },
			]),
		).toBe("ada");
    expect(githubUsernameToSlackId("louisedesadeleer")).toBeNull(); // historical omission preserved
    expect(githubUsernameToSlackId("happylinks")).toBe("UT41L6GCC");
    expect(linearEmailToGithubUsername("jaap@tella.com")).toBe("jfrolich");
		expect(personKeyToDisplayName("michiel")).toBe("Michiel");
		expect(
			personKeyToDisplayName("ada", [
				{ name: "Ada Lovelace", aliases: ["ada"], github: "ada" },
			]),
		).toBe("Ada");
    expect(slackIdToFirstName("U086HCZURPM")).toBe("Grant");
    expect(userMatchesAny("grant", ["Grant"])).toBe(true);
    expect(userMatchesAny("someone-else", ["Grant"])).toBe(false);
    expect(userMatchesAny(undefined, [])).toBe(true);
  });

  test("empty team → empty tables, no throws", () => {
    const t = deriveIdentityTables([], {});
    expect(t.githubToSlack).toEqual({});
    expect(t.linearEmailToGithub).toEqual({});
    expect(t.slackIdToName).toEqual({});
    expect(t.teamGitIdentity).toEqual([]);
  });

  test("member without explicit aliases gets the lowercased first name", () => {
    const t = deriveIdentityTables([{ name: "Ada Lovelace", email: "ada@acme.dev" }]);
    expect(t.teamGitIdentity).toEqual([
      { name: "Ada Lovelace", email: "ada@acme.dev", aliases: ["ada"] },
    ]);
  });
});
