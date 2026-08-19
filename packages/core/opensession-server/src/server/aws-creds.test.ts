import { describe, expect, test } from "bun:test";
import {
  AWS_HUMAN_AUTH_DENIAL,
  isAwsHumanAuthRequest,
} from "./aws-creds";
import { makeAskHandler } from "./asks";

describe("AWS human-auth guard", () => {
  test("blocks AWS SSO device authorization requests", () => {
    expect(
      isAwsHumanAuthRequest(
        "AWS login",
        "Please authorize stage log access at https://d-9a67574b8b.awsapps.com/start/#/device with code XBBV-XSJV."
      )
    ).toBe(true);
    expect(
      isAwsHumanAuthRequest(
        "Please approve the AWS SSO device login and enter the code."
      )
    ).toBe(true);
    expect(
      isAwsHumanAuthRequest(
        "Open the Amazon Web Services device authorization page and sign in."
      )
    ).toBe(true);
  });

  test("does not block ordinary AWS or unrelated login questions", () => {
    expect(isAwsHumanAuthRequest("Which IAM role should stage logs use?")).toBe(false);
    expect(isAwsHumanAuthRequest("Can you review this AWS policy?")).toBe(false);
    expect(isAwsHumanAuthRequest("Please sign in to GitHub.")).toBe(false);
  });

  test("denial tells the agent to stop interactive auth and degrade gracefully", () => {
    expect(AWS_HUMAN_AUTH_DENIAL).toContain("Do not run `aws login`");
    expect(AWS_HUMAN_AUTH_DENIAL).toContain("do not ask anyone");
    expect(AWS_HUMAN_AUTH_DENIAL).toContain("continue without AWS");
  });

  test("ask_user rejects the request before opening a human question", async () => {
    const result = await makeAskHandler("test-aws-auth-guard")({
      questions: [
        {
          header: "AWS login",
          question:
            "Please authorize stage log access at https://d-9a67574b8b.awsapps.com/start/#/device with code XBBV-XSJV, then confirm when complete?",
        },
      ],
    });
    expect(result).toEqual({
      behavior: "deny",
      message: AWS_HUMAN_AUTH_DENIAL,
    });
  });
});
