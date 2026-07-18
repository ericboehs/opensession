/**
 * Ordered HTTP route handler chain. Handlers are grouped by domain; a handler
 * returns undefined to fall through. Order across modules is free because the
 * path families are disjoint — order WITHIN a family (e.g. /notes/search
 * before /notes/:id) is preserved inside its module. The WebSocket upgrade,
 * run-ws upgrades, SPA fallback and 404 stay in opensession.ts's fetch tail.
 */

import type { RouteHandler } from "./context";
import { handleAuthRoutes } from "./auth";
import { handleMediaRoutes } from "./media";
import { handleStaticAssetsRoutes } from "./static-assets";
import { handlePlainRoutes } from "./plain";
import { handleSystemRoutes } from "./system";
import { handleSessionAssetsRoutes } from "./session-assets";
import { handleSessionsRoutes } from "./sessions";
import { handlePrRoutes } from "./pr";
import { handleSessionGitRoutes } from "./session-git";
import { handlePreviewRoutes } from "./preview";
import { handleWorkspaceRoutes } from "./workspace";
import { handleAutomationsRoutes } from "./automations";
import { handleHumanAsksRoutes } from "./human-asks";
import { handleChatRoutes } from "./chat";
import { handlePrefsRoutes } from "./prefs";
import { handleSecurityRoutes } from "./security";
import { handleGoalsRoutes } from "./goals";
import { handleActionsRoutes } from "./actions";
import { handleConnectionsRoutes } from "./connections";
import { handleAccountsRoutes } from "./accounts";
import { handleModelsRoutes } from "./models";
import { handleNotesRoutes } from "./notes";
import { handlePapercutsRoutes } from "./papercuts";
import { handleWorkflowsRoutes } from "./workflows";
import { handleSideChatsRoutes } from "./side-chats";
import { handleReportsRoutes } from "./reports";
import { handleAnalyticsRoutes } from "./analytics";

export type { RouteContext, RouteHandler } from "./context";

export const routeHandlers: RouteHandler[] = [
	// First: the sign-in endpoints are exempt from the auth gate (which runs
	// before dispatch in opensession.ts) and must never be shadowed.
	handleAuthRoutes,
	handleMediaRoutes,
	handleStaticAssetsRoutes,
	handlePlainRoutes,
	handleSystemRoutes,
	// Before the generic session routes: /api/sessions/:id/assets* is inside
	// their path family and must not be swallowed by broader matches.
	handleSessionAssetsRoutes,
	handleSessionsRoutes,
	handlePrRoutes,
	handleSessionGitRoutes,
	handlePreviewRoutes,
	handleWorkspaceRoutes,
	handleAutomationsRoutes,
	handleHumanAsksRoutes,
	handleChatRoutes,
	handlePrefsRoutes,
	handleSecurityRoutes,
	handleGoalsRoutes,
	handleActionsRoutes,
	handleConnectionsRoutes,
	handleAccountsRoutes,
	handleModelsRoutes,
	handleNotesRoutes,
	handlePapercutsRoutes,
	handleWorkflowsRoutes,
	handleSideChatsRoutes,
	handleReportsRoutes,
	handleAnalyticsRoutes,
];
