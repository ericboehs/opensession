/**
 * Linear agent webhook handlers for AgentSession and Issue events.
 */
import { linearEmailToGithubUsername } from "../../server/shared/user-mappings";
import {
  createAgentActivity,
  fetchLinearUser,
  getIssueDetails,
  getIssueStatus,
  issueHasPlan,
  moveToStatus,
  postComment,
  updateAgentSession,
} from "./api";
import type { LinearTokens } from "./oauth";
import { getValidToken } from "./oauth";
import {
  PLANNING_PROMPT,
  IMPLEMENTATION_PROMPT,
  PLANNING_CONTINUATION_PROMPT,
  GREETING_PROMPT,
  MESSAGES,
} from "./prompts";
import {
  activeSessions,
  processedSessions,
  buildParticipantSections,
  createPrWithAttribution,
  createWorktree,
  deleteSessionFile,
  deleteWorktree,
  formatConversationHistory,
  generateBranchName,
  getLastMessageUuid,
  loadSessionInfo,
  michaelSessionUrl,
  runClaudeHeadless,
  saveSessionInfo,
  startRalphLoop,
  startRalphPolling,
  startSessionPolling,
  stopSessionPolling,
  type ActiveSession,
} from "./session";

// --- Webhook types ---

export interface AgentSessionWebhook {
  action: "created" | "updated" | "ended" | "dismissed" | "prompted";
  type: "AgentSession";
  organizationId: string;
  actor?: { id: string; name: string };
  agentSession: {
    id: string;
    status: string;
    issue: {
      id: string;
      identifier: string;
      title: string;
      description?: string;
      url: string;
    };
    comments?: Array<{ id: string; body: string }>;
  };
  agentActivity?: {
    signal?: string;
    userId?: string;
    content?: { type: string; body: string };
  };
}

export interface IssueWebhook {
  action: "create" | "update" | "remove";
  type: "Issue";
  organizationId: string;
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url: string;
    stateId?: string;
    assigneeId?: string;
  };
  updatedFrom?: {
    stateId?: string;
    assigneeId?: string;
  };
}

// --- Issue status change → auto-implement ---

export async function handleIssueUpdate(webhook: IssueWebhook, tokens: LinearTokens): Promise<Response> {
  const { data: issue, organizationId, updatedFrom } = webhook;

  if (webhook.action !== "update") {
    return Response.json({ ok: true });
  }

  if (!updatedFrom?.stateId) {
    return Response.json({ ok: true });
  }

  const accessToken = await getValidToken(organizationId, tokens);
  if (!accessToken) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const details = await getIssueDetails(accessToken, issue.id);
  console.log(`[linear] Issue ${issue.identifier} status changed to: ${details.status}`);

  if (details.status.toLowerCase() !== "in progress") {
    return Response.json({ ok: true });
  }

  // Check for existing session
  let existingSession: ActiveSession | undefined;
  for (const [, session] of activeSessions) {
    if (session.issueIdentifier === issue.identifier || session.issueId === issue.id) {
      existingSession = session;
      break;
    }
  }

  if (!existingSession) {
    const branch = await generateBranchName(details.title, issue.identifier);
    const diskSession = await loadSessionInfo(branch);
    if (diskSession?.claudeSessionId) {
      existingSession = {
        branch,
        claudeSessionId: diskSession.claudeSessionId,
        accessToken,
        issueTitle: details.title,
        issueIdentifier: issue.identifier,
        issueId: issue.id,
        issueDescription: details.description,
        issueUrl: details.url,
        teamId: details.teamId,
        worktreeDir: diskSession.worktreeDir,
        linearSessionId: diskSession.linearSessionId || "",
        lastMessageUuid: null,
        isPlanning: false,
        planningConversation: [],
        awaitingImplementationConfirmation: diskSession.awaitingImplementationConfirmation || false,
        awaitingInitialDirection: false,
        isRalphMode: diskSession.isRalphMode || false,
        participants: diskSession.participants || [],
        lastActiveUser: diskSession.lastActiveUser || null,
        issueCreator: diskSession.issueCreator || details.creator || null,
        model: diskSession.model,
      };
      if (diskSession.linearSessionId) {
        activeSessions.set(diskSession.linearSessionId, existingSession);
      }
    }
  }

  if (!existingSession) {
    return Response.json({ ok: true });
  }

  const hasPlan = await issueHasPlan(accessToken, issue.id);
  if (!hasPlan) {
    return Response.json({ ok: true });
  }

  if (existingSession.isRalphMode) {
    return Response.json({ ok: true });
  }

  console.log(`[linear] Auto-implementing ${issue.identifier} - has plan and moved to In Progress`);

  if (existingSession.claudeSessionId) {
    existingSession.awaitingImplementationConfirmation = false;
    existingSession.isPlanning = false;

    const { participantsSection, coAuthorInstruction } = buildParticipantSections(
      existingSession.participants || [],
      existingSession.lastActiveUser || null
    );
    const implementationPrompt = IMPLEMENTATION_PROMPT
      .replaceAll("$ISSUE_ID", issue.identifier)
      .replaceAll("$ISSUE_URL", details.url)
      .replaceAll("$ISSUE_TITLE", details.title)
      .replaceAll("$ISSUE_DESCRIPTION", details.description)
      .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
      .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

    (async () => {
      try {
        if (existingSession!.linearSessionId) {
          await createAgentActivity(accessToken, existingSession!.linearSessionId, {
            type: "thought",
            body: `Auto-starting implementation (ticket moved to In Progress)`,
          });
        }

        const { result, claudeSessionId } = await runClaudeHeadless(
          existingSession!.worktreeDir,
          implementationPrompt,
          existingSession!.linearSessionId,
          accessToken,
          existingSession!.claudeSessionId || undefined,
          existingSession!
        );

        existingSession!.claudeSessionId = claudeSessionId;
        existingSession!.lastMessageUuid = await getLastMessageUuid(existingSession!.worktreeDir, claudeSessionId);

        await saveSessionInfo(
          existingSession!.branch,
          claudeSessionId,
          issue.identifier,
          details.title,
          existingSession!.worktreeDir,
          existingSession!.linearSessionId,
          undefined,
          undefined,
          existingSession!.issueId,
          existingSession!.issueUrl,
          existingSession!.participants,
          existingSession!.lastActiveUser
        );

        if (result?.includes("IMPLEMENTATION_COMPLETE") && existingSession!.linearSessionId) {
          const creatorGithub = linearEmailToGithubUsername(existingSession!.issueCreator?.email || null);
          const prUrl = await createPrWithAttribution(
            existingSession!.worktreeDir,
            issue.identifier,
            details.url,
            details.title,
            existingSession!.participants || [],
            creatorGithub
          );

          await createAgentActivity(accessToken, existingSession!.linearSessionId, {
            type: "response",
            body: prUrl
              ? `Implementation complete! PR: ${prUrl}`
              : "Implementation complete! PR creation may have failed - please check manually.",
          });
        }
      } catch (e) {
        console.error(`[linear] Error auto-implementing ${issue.identifier}:`, e);
      }
    })();
  }

  return Response.json({ ok: true, autoImplementing: true });
}

// --- Agent session webhook ---

export async function handleAgentSession(
  webhook: AgentSessionWebhook,
  tokens: LinearTokens
): Promise<Response> {
  const { agentSession, organizationId, action } = webhook;

  // Stop signal
  if (action === "prompted" && webhook.agentActivity?.signal === "stop") {
    console.log(`[linear] Stop signal for issue: ${agentSession.issue.identifier}`);
    const session = activeSessions.get(agentSession.id);
    if (session) {
      if (session.abortController) {
        session.abortController.abort();
        session.abortController = undefined;
      }
      if (session.isRalphMode && session.ralphProcess) {
        session.ralphProcess.kill();
        session.ralphProcess = undefined;
      }
      if (session.ralphPollInterval) {
        clearInterval(session.ralphPollInterval);
        session.ralphPollInterval = undefined;
      }
      session.isRalphMode = false;
      stopSessionPolling(session);
    }
    return Response.json({ ok: true });
  }

  // Prompted — user sends message
  if (action === "prompted" && webhook.agentActivity?.content?.body) {
    const prompt = webhook.agentActivity.content.body;
    console.log(`[linear] Prompt from Linear: ${prompt.substring(0, 50)}...`);

    let session = activeSessions.get(agentSession.id);

    // Recover from disk
    if (!session) {
      const branch = await generateBranchName(agentSession.issue.title, agentSession.issue.identifier);
      const diskSession = await loadSessionInfo(branch);
      if (diskSession) {
        console.log(`[linear] Recovered session from disk for branch: ${branch}`);
        // Older sessions may predate external links — idempotent by url
        getValidToken(organizationId, tokens).then((t) => {
          if (t) {
            updateAgentSession(t, agentSession.id, {
              addedExternalUrls: [{ url: michaelSessionUrl(branch), label: "Open in Michael" }],
            }).catch(() => {});
          }
        }).catch(() => {});
        session = {
          branch,
          claudeSessionId: diskSession.claudeSessionId,
          accessToken: "",
          issueTitle: agentSession.issue.title,
          issueIdentifier: diskSession.issueIdentifier,
          issueId: agentSession.issue.id,
          issueDescription: agentSession.issue.description || "",
          issueUrl: agentSession.issue.url,
          teamId: "",
          worktreeDir: diskSession.worktreeDir,
          linearSessionId: agentSession.id,
          lastMessageUuid: null,
          isPlanning: false,
          planningConversation: [],
          awaitingImplementationConfirmation: diskSession.awaitingImplementationConfirmation || false,
          awaitingInitialDirection: diskSession.awaitingInitialDirection || false,
          isRalphMode: diskSession.isRalphMode || false,
          participants: diskSession.participants || [],
          lastActiveUser: diskSession.lastActiveUser || null,
          issueCreator: diskSession.issueCreator || null,
          model: diskSession.model,
        };
        activeSessions.set(agentSession.id, session);
        if (diskSession.claudeSessionId) {
          session.lastMessageUuid = await getLastMessageUuid(diskSession.worktreeDir, diskSession.claudeSessionId);
        }
        if (diskSession.isRalphMode) {
          const at = await getValidToken(organizationId, tokens);
          if (at) startRalphPolling(session, at, agentSession.id);
        } else {
          startSessionPolling(session);
        }
      }
    }

    if (session) {
      if (!session.participants) session.participants = [];

      const accessToken = await getValidToken(organizationId, tokens);
      if (accessToken) {
        session.accessToken = accessToken;

        if (!session.teamId) {
          const { teamId } = await getIssueStatus(accessToken, session.issueId);
          session.teamId = teamId;
        }

        // Track participant
        const promptUserId = webhook.agentActivity?.userId;
        if (promptUserId) {
          const existingIdx = session.participants.findIndex((p) => p.id === promptUserId);
          if (existingIdx === -1) {
            const userParticipant = await fetchLinearUser(accessToken, promptUserId);
            if (userParticipant) {
              session.participants.push(userParticipant);
              session.lastActiveUser = userParticipant;
            }
          } else {
            session.lastActiveUser = session.participants[existingIdx];
          }
        }

        let effectivePrompt = prompt;

        // Initial direction routing
        if (session.awaitingInitialDirection) {
          session.awaitingInitialDirection = false;
          const lowerPrompt = prompt.toLowerCase().trim();

          if (lowerPrompt.includes("plan")) {
            session.isPlanning = true;
            effectivePrompt = PLANNING_PROMPT
              .replaceAll("$ISSUE_ID", session.issueIdentifier)
              .replaceAll("$ISSUE_URL", session.issueUrl)
              .replaceAll("$ISSUE_TITLE", session.issueTitle)
              .replaceAll("$ISSUE_DESCRIPTION", session.issueDescription || "(No description)");

            await createAgentActivity(accessToken, agentSession.id, {
              type: "thought",
              body: "Starting planning interview...",
            });
          } else if (lowerPrompt.includes("implement")) {
            session.isPlanning = false;
            await moveToStatus(accessToken, session.issueId, session.teamId, "In Progress");

            const { participantsSection, coAuthorInstruction } = buildParticipantSections(
              session.participants || [],
              session.lastActiveUser || null
            );
            effectivePrompt = IMPLEMENTATION_PROMPT
              .replaceAll("$ISSUE_ID", session.issueIdentifier)
              .replaceAll("$ISSUE_URL", session.issueUrl)
              .replaceAll("$ISSUE_TITLE", session.issueTitle)
              .replaceAll("$ISSUE_DESCRIPTION", session.issueDescription || "(No description)")
              .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
              .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

            await createAgentActivity(accessToken, agentSession.id, {
              type: "thought",
              body: MESSAGES.implementationStarted,
            });
          } else {
            session.isPlanning = false;
            effectivePrompt = `You are Michael, working on Linear ticket ${session.issueIdentifier} (${session.issueUrl}).

**Title:** ${session.issueTitle}
**Description:** ${session.issueDescription}

The user said: "${prompt}"

Help with whatever they're asking. You have a worktree ready at ${session.worktreeDir}.`;
          }
        }

        // Implementation confirmation
        else if (session.awaitingImplementationConfirmation) {
          const lowerPrompt = prompt.toLowerCase().trim();

          if (lowerPrompt.includes("ralph")) {
            session.awaitingImplementationConfirmation = false;
            session.isRalphMode = true;
            await startRalphLoop(session, accessToken, agentSession.id);
            return Response.json({ ok: true });
          }

          session.awaitingImplementationConfirmation = false;
          const { participantsSection, coAuthorInstruction } = buildParticipantSections(
            session.participants || [],
            session.lastActiveUser || null
          );
          effectivePrompt = IMPLEMENTATION_PROMPT
            .replaceAll("$ISSUE_ID", session.issueIdentifier)
            .replaceAll("$ISSUE_URL", session.issueUrl)
            .replaceAll("$ISSUE_TITLE", session.issueTitle)
            .replaceAll("$ISSUE_DESCRIPTION", session.issueDescription)
            .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
            .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

          await moveToStatus(accessToken, session.issueId, session.teamId, "In Progress");
          await createAgentActivity(accessToken, agentSession.id, {
            type: "thought",
            body: MESSAGES.implementationStarted,
          });
        }

        // Ralph mode
        if (session.isRalphMode) {
          const lowerPrompt = prompt.toLowerCase().trim();
          if (lowerPrompt === "stop" || lowerPrompt.includes("stop ralph")) {
            if (session.ralphProcess) session.ralphProcess.kill();
            if (session.ralphPollInterval) clearInterval(session.ralphPollInterval);
            session.isRalphMode = false;
            await createAgentActivity(accessToken, agentSession.id, {
              type: "response",
              body: "Ralph loop stopped. You can now interact with the session normally.",
            });
            return Response.json({ ok: true });
          }
          await createAgentActivity(accessToken, agentSession.id, {
            type: "thought",
            body: "Ralph is running... Reply 'stop' if you need to interrupt.",
          });
          return Response.json({ ok: true });
        }

        // Planning continuation
        if (session.isPlanning && session.planningConversation.length > 0) {
          session.planningConversation.push({
            role: "user",
            content: prompt,
            timestamp: new Date().toISOString(),
          });
          effectivePrompt = PLANNING_CONTINUATION_PROMPT
            .replaceAll("$ISSUE_ID", session.issueIdentifier)
            .replaceAll("$CONVERSATION_HISTORY", formatConversationHistory(session.planningConversation.slice(0, -1)))
            .replaceAll("$LATEST_RESPONSE", prompt);
        }

        // Run Claude in background
        const s = session;
        (async () => {
          try {
            const { result, claudeSessionId } = await runClaudeHeadless(
              s.worktreeDir,
              effectivePrompt,
              agentSession.id,
              accessToken,
              s.claudeSessionId || undefined,
              s
            );

            s.claudeSessionId = claudeSessionId;
            s.lastMessageUuid = await getLastMessageUuid(s.worktreeDir, claudeSessionId);

            await saveSessionInfo(
              s.branch,
              claudeSessionId,
              s.issueIdentifier,
              s.issueTitle,
              s.worktreeDir,
              s.linearSessionId,
              undefined,
              undefined,
              s.issueId,
              s.issueUrl,
              s.participants,
              s.lastActiveUser
            );

            if (result) {
              if (result.includes("PLANNING_COMPLETE") && s.isPlanning) {
                const planMatch = result.split("PLANNING_COMPLETE")[0].trim();
                if (planMatch) {
                  await postComment(accessToken, s.issueId, `# Implementation Plan\n\n${planMatch}`);
                }

                await moveToStatus(accessToken, s.issueId, s.teamId, "Ready");
                s.isPlanning = false;
                s.planningConversation = [];
                s.awaitingImplementationConfirmation = true;

                await saveSessionInfo(
                  s.branch,
                  s.claudeSessionId,
                  s.issueIdentifier,
                  s.issueTitle,
                  s.worktreeDir,
                  s.linearSessionId,
                  false,
                  true,
                  s.issueId,
                  s.issueUrl,
                  s.participants,
                  s.lastActiveUser
                );

                await createAgentActivity(accessToken, agentSession.id, {
                  type: "elicitation",
                  body: `${MESSAGES.planningComplete}\n\n**How would you like to proceed?**\n- Reply "one-shot" - Single Claude session implementation\n- Reply "ralph" - Iterative task loop with progress updates`,
                });
              } else if (result.includes("IMPLEMENTATION_COMPLETE")) {
                const creatorGithub = linearEmailToGithubUsername(s.issueCreator?.email || null);
                const prUrl = await createPrWithAttribution(
                  s.worktreeDir,
                  s.issueIdentifier,
                  s.issueUrl,
                  s.issueTitle,
                  s.participants || [],
                  creatorGithub
                );

                await createAgentActivity(accessToken, agentSession.id, {
                  type: "response",
                  body: prUrl
                    ? `Implementation complete! PR: ${prUrl}`
                    : "Implementation complete! PR creation may have failed - please check manually.",
                });
              } else {
                if (s.isPlanning) {
                  s.planningConversation.push({
                    role: "michael",
                    content: result,
                    timestamp: new Date().toISOString(),
                  });
                }
                // Planning-interview turns are questions by design → elicitation
                // (Linear prompts the user to answer); runner failures → error.
                const type = s.isPlanning
                  ? "elicitation"
                  : result.startsWith("Error:")
                    ? "error"
                    : "response";
                await createAgentActivity(accessToken, agentSession.id, {
                  type,
                  body: result,
                });
              }
            }
          } catch (e) {
            console.error(`[linear] Error running Claude for prompt:`, e);
            await createAgentActivity(accessToken, agentSession.id, {
              type: "error",
              body: `${e}`,
            });
          }
        })();
      }
    } else {
      console.log(`[linear] No active session found for ${agentSession.id}`);
    }
    return Response.json({ ok: true });
  }

  // Dismissed/ended — cleanup
  if (action === "dismissed" || action === "ended") {
    console.log(`[linear] Session ${action} for issue: ${agentSession.issue.identifier}`);
    const branch = await generateBranchName(agentSession.issue.title, agentSession.issue.identifier);
    try {
      const session = activeSessions.get(agentSession.id);
      if (session) {
        if (session.isRalphMode && session.ralphProcess) session.ralphProcess.kill();
        if (session.ralphPollInterval) clearInterval(session.ralphPollInterval);
        stopSessionPolling(session);
      }
      deleteWorktree(branch);
      deleteSessionFile(branch);
      activeSessions.delete(agentSession.id);
    } catch (e) {
      console.log(`[linear] Could not delete worktree ${branch}: ${e}`);
    }
    return Response.json({ ok: true });
  }

  // Created — new session
  if (action !== "created") {
    return Response.json({ ok: true });
  }

  const sessionId = agentSession.id;
  if (processedSessions.has(sessionId)) {
    return Response.json({ ok: true, skipped: true });
  }
  processedSessions.add(sessionId);
  setTimeout(() => processedSessions.delete(sessionId), 5 * 60 * 1000);

  const accessToken = await getValidToken(organizationId, tokens);
  if (!accessToken) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const { issue } = agentSession;
  console.log(`[linear] New session for issue: ${issue.identifier} - ${issue.title}`);

  await createAgentActivity(accessToken, agentSession.id, {
    type: "thought",
    body: MESSAGES.starting,
  });

  const { teamId } = await getIssueStatus(accessToken, issue.id);
  const issueDetails = await getIssueDetails(accessToken, issue.id);

  const branch = await generateBranchName(issue.title, issue.identifier);
  const worktreeDir = `/home/ubuntu/worktrees/tella-fusion-${branch}`;

  const session: ActiveSession = {
    branch,
    claudeSessionId: null,
    accessToken,
    issueTitle: issue.title,
    issueIdentifier: issue.identifier,
    issueId: issue.id,
    issueDescription: issue.description || "",
    issueUrl: issue.url,
    teamId,
    worktreeDir,
    linearSessionId: agentSession.id,
    lastMessageUuid: null,
    isPlanning: false,
    planningConversation: [],
    awaitingImplementationConfirmation: false,
    awaitingInitialDirection: true,
    isRalphMode: false,
    participants: [],
    lastActiveUser: null,
    issueCreator: issueDetails.creator,
  };
  activeSessions.set(agentSession.id, session);

  (async () => {
    try {
      createWorktree(branch, issue.identifier, issue.title, issue.description || "", issue.url);

      await saveSessionInfo(
        branch,
        null,
        issue.identifier,
        issue.title,
        worktreeDir,
        agentSession.id,
        undefined,
        undefined,
        issue.id,
        issue.url,
        session.participants,
        session.lastActiveUser,
        true,
        session.issueCreator
      );

      // Link the Linear session to the Michael web UI session viewer
      updateAgentSession(accessToken, agentSession.id, {
        addedExternalUrls: [{ url: michaelSessionUrl(branch), label: "Open in Michael" }],
      }).catch(() => {});

      const greeting = GREETING_PROMPT
        .replaceAll("$ISSUE_ID", issue.identifier)
        .replaceAll("$ISSUE_TITLE", issue.title);

      // The greeting asks for direction (plan/implement/other) → elicitation
      await createAgentActivity(accessToken, agentSession.id, {
        type: "elicitation",
        body: greeting,
      });
    } catch (e) {
      console.error(`[linear] Error in session creation:`, e);
      await createAgentActivity(accessToken, agentSession.id, {
        type: "error",
        body: `${MESSAGES.error} Failed to initialize: ${e}`,
      });
    }
  })();

  return Response.json({ ok: true, branch });
}
