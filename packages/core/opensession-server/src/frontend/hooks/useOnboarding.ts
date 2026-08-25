import { useEffect, useState } from "react";
import { BASE_PATH } from "../lib/base";

export type OnboardingState = "loading" | "required" | "complete" | "failed";

async function request(init?: RequestInit): Promise<boolean> {
	const response = await fetch(`${BASE_PATH}/api/setup/onboarding`, init);
	const body = await response.json().catch(() => null);
	if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
	return body?.completed === true;
}

/** The instance-wide first-run gate. Unlike a UI preference, this follows the
 * server across browsers and users, and only the final onboarding action can
 * move it to complete. */
export function useOnboarding() {
	const [state, setState] = useState<OnboardingState>("loading");

	async function refetch() {
		setState("loading");
		try {
			setState((await request()) ? "complete" : "required");
		} catch {
			setState("failed");
		}
	}

	useEffect(() => {
		const reload = () => void refetch();
		reload();
		// The hook mounts outside UserGate. A signed-out first request may 401;
		// retry as soon as device-code sign-in establishes the current user.
		window.addEventListener("opensession-user-changed", reload);
		return () => window.removeEventListener("opensession-user-changed", reload);
	}, []);

	async function complete() {
		await request({
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ completed: true }),
		});
		setState("complete");
	}

	return { state, refetch, complete };
}
