import { describe, expect, test } from "bun:test";
import type { TeamMember } from "../config";
import {
  deriveIdentityTables,
  githubLoginToPersonKeyFromTeam,
  personKeyToDisplayName,
} from "./user-mappings";

const TEAM: TeamMember[] = [
  {
    name: "Alice Example",
    email: "alice@example.com",
    aliases: ["alice", "ali"],
    slackId: "U_ALICE",
    github: "alice",
    linearEmails: ["alice@work.example"],
  },
  {
    name: "Bob Builder",
    email: "bob@example.com",
    slackId: "U_BOB",
    github: "bob",
    linearEmails: ["bob@work.example"],
    githubToSlack: false,
  },
];

describe("identity table derivation", () => {
  test("derives GitHub, Slack, Linear, and git attribution tables from config", () => {
    const tables = deriveIdentityTables(TEAM, { U_SYSTEM: "Build Bot" });

    expect(tables.githubToSlack).toEqual({ alice: "U_ALICE" });
    expect(tables.linearEmailToGithub).toEqual({
      "alice@work.example": "alice",
      "bob@work.example": "bob",
    });
    expect(tables.slackIdToName).toEqual({
      U_ALICE: "Alice Example",
      U_BOB: "Bob Builder",
      U_SYSTEM: "Build Bot",
    });
    expect(tables.teamGitIdentity).toEqual([
      {
        name: "Alice Example",
        email: "alice@example.com",
        aliases: ["alice", "ali"],
        slackId: "U_ALICE",
        github: "alice",
      },
      {
        name: "Bob Builder",
        email: "bob@example.com",
        aliases: ["bob"],
        slackId: "U_BOB",
        github: "bob",
      },
    ]);
  });

  test("empty team produces empty tables", () => {
    expect(deriveIdentityTables([], {})).toEqual({
      githubToSlack: {},
      linearEmailToGithub: {},
      slackIdToName: {},
      teamGitIdentity: [],
    });
  });

  test("member without explicit aliases uses the lowercased first name", () => {
    const tables = deriveIdentityTables([
      { name: "Ada Lovelace", email: "ada@example.com" },
    ]);
    expect(tables.teamGitIdentity).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com", aliases: ["ada"] },
    ]);
  });

  test("directory display helpers accept an explicit configured team", () => {
    expect(githubLoginToPersonKeyFromTeam("alice", TEAM)).toBe("alice");
    expect(githubLoginToPersonKeyFromTeam("unknown", TEAM)).toBeNull();
    expect(personKeyToDisplayName("ali", TEAM)).toBe("Alice");
    expect(personKeyToDisplayName("unknown", TEAM)).toBeNull();
  });
});
