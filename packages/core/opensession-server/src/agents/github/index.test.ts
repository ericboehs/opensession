import { afterEach, describe, expect, test } from "bun:test";
import { GithubAgent } from "./index";
import { SlackAgent } from "../slack/index";

const originalGithub = process.env.ENABLE_GITHUB_AGENT;
const originalSlack = process.env.ENABLE_SLACK_AGENT;
const originalWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
const originalApiToken = process.env.GITHUB_API_TOKEN;

afterEach(() => {
  if (originalGithub === undefined) delete process.env.ENABLE_GITHUB_AGENT;
  else process.env.ENABLE_GITHUB_AGENT = originalGithub;
  if (originalSlack === undefined) delete process.env.ENABLE_SLACK_AGENT;
  else process.env.ENABLE_SLACK_AGENT = originalSlack;
  if (originalWebhookSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
  else process.env.GITHUB_WEBHOOK_SECRET = originalWebhookSecret;
  if (originalApiToken === undefined) delete process.env.GITHUB_API_TOKEN;
  else process.env.GITHUB_API_TOKEN = originalApiToken;
});

describe("webhook route ownership", () => {
  test("GitHub-only registration belongs to GitHub", () => {
    process.env.ENABLE_GITHUB_AGENT = "true";
    process.env.ENABLE_SLACK_AGENT = "false";
    expect(new GithubAgent().getRoutes().has("POST /github/webhook")).toBe(true);
    expect(new SlackAgent().getRoutes().has("POST /github/webhook")).toBe(false);
  });

  test("Slack-only registration uses the GitHub compatibility handler", () => {
    process.env.ENABLE_GITHUB_AGENT = "false";
    process.env.ENABLE_SLACK_AGENT = "true";
    process.env.GITHUB_WEBHOOK_SECRET = "configured";
    process.env.GITHUB_API_TOKEN = "configured";
    expect(new SlackAgent().getRoutes().has("POST /github/webhook")).toBe(true);
    expect(new SlackAgent().health()).toMatchObject({
      githubWebhookConfigured: true,
      githubApiTokenConfigured: true,
      githubWebhooksReceived: expect.any(Number),
    });
  });

  test("both enabled leaves route ownership with GitHub", () => {
    process.env.ENABLE_GITHUB_AGENT = "true";
    process.env.ENABLE_SLACK_AGENT = "true";
    expect(new GithubAgent().getRoutes().has("POST /github/webhook")).toBe(true);
    expect(new SlackAgent().getRoutes().has("POST /github/webhook")).toBe(false);
    expect(new SlackAgent().health()).not.toHaveProperty("githubWebhooksReceived");
  });
});
