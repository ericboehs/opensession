import {
  githubCredentialForLogin,
  serviceGithubCredential,
  type GithubCredential,
} from "../github-auth";
import { webAuthRequired } from "../web-auth";
import type { RouteContext } from "./context";

/**
 * Resolve an explicit credential for a human-triggered GitHub mutation.
 * Authenticated deployments never fall back to the service identity, because
 * that would attribute a deliberate human action to the bot.
 */
export function githubMutationCredential(ctx: RouteContext): GithubCredential | null {
  if (!webAuthRequired()) return serviceGithubCredential;
  return ctx.authUser?.login ? githubCredentialForLogin(ctx.authUser.login) : null;
}

export function githubCredentialRequiredResponse(): Response {
  return Response.json(
    { error: "Connect your GitHub account before changing a pull request." },
    { status: 403 },
  );
}
