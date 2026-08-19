import { request } from "./request";

// ── Goals (long-running, self-pacing missions) ──

export async function fetchGoals() {
	return request<any>("/goals", { label: "Failed to fetch goals" });
}

/** Single goal incl. its ledger text (for the detail view). */
export async function fetchGoal(id: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}`, {
		label: "Failed to fetch goal",
	});
}

export async function createGoalApi(input: {
	name: string;
	mission: string;
	mode?: "ask" | "code";
	repo?: string;
	model?: string;
	fallbackModel?: string;
	mcpServers?: string[];
	minWakeMinutes?: number;
	maxWakes?: number;
	createdBy: string;
}) {
	return request<any>("/goals", { method: "POST", body: input });
}

export async function updateGoalApi(id: string, patch: object) {
	return request<any>(`/goals/${encodeURIComponent(id)}`, {
		method: "PUT",
		body: patch,
	});
}

export async function deleteGoalApi(id: string) {
	await request<void>(`/goals/${encodeURIComponent(id)}`, {
		method: "DELETE",
		label: "Failed to delete",
	});
}

export async function runGoalApi(id: string) {
	await request<void>(`/goals/${encodeURIComponent(id)}/run`, {
		method: "POST",
	});
}

export async function resumeGoalApi(id: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}/resume`, {
		method: "POST",
		body: {},
	});
}

export async function pauseGoalApi(id: string, reason?: string) {
	return request<any>(`/goals/${encodeURIComponent(id)}/pause`, {
		method: "POST",
		body: { reason },
	});
}
