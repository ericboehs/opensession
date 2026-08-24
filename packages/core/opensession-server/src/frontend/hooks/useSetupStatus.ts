import { useCallback, useEffect, useRef, useState } from "react";
import {
	setupRequest,
	type SetupGithub,
	type SetupIntegration,
	type SetupRepo,
	type SetupStatus,
} from "../components/setup-shared";
import { BASE_PATH } from "../lib/base";
import { toast } from "../ui/toast";

// GET /api/setup/status, plus the restart choreography every page built on it
// needs: credentials and enable flags are read on boot, so whichever page took
// the edit has to be the one that offers the restart. The Setup wizard and the
// Workspace settings pages that hold the same sections (Repositories, Members,
// Integrations, Identity) share this one controller, so they can't drift on
// what "saved" means or on which of them can bring the change into effect.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type RestartState = "idle" | "working" | "failed";

export interface SetupController {
	status: SetupStatus | null;
	/** The first load failed and there is nothing cached to show. */
	failed: boolean;
	refetch: () => Promise<void>;
	restartNeeded: boolean;
	restartState: RestartState;
	/** Restart the server, then poll until it answers. `post: false` only
	 *  polls — the "Check again" path after a timeout. */
	restartServer: (post?: boolean) => Promise<void>;
	/** Fold a saved integration back into the cached status. */
	applyIntegration: (updated: SetupIntegration, restartRequired: boolean) => void;
	applyGithub: (updated: SetupGithub, restartRequired: boolean) => void;
	applyRepo: (updated: Pick<SetupRepo, "id" | "defaultBranch">) => void;
}

export function useSetupStatus(): SetupController {
	const [status, setStatus] = useState<SetupStatus | null>(null);
	const [failed, setFailed] = useState(false);
	const [restartNeeded, setRestartNeeded] = useState(false);
	const [restartState, setRestartState] = useState<RestartState>("idle");
	const statusRef = useRef<SetupStatus | null>(null);
	statusRef.current = status;

	const refetch = useCallback(async () => {
		try {
			const body = await setupRequest<SetupStatus>("/api/setup/status");
			setStatus(body);
			setFailed(false);
		} catch {
			// A refetch that fails while a status is already on screen keeps the
			// stale one: better a slightly old page than an empty one.
			if (!statusRef.current) setFailed(true);
		}
	}, []);

	useEffect(() => {
		refetch();
	}, [refetch]);

	const applyIntegration = useCallback(
		(updated: SetupIntegration, restartRequired: boolean) => {
			setStatus((s) =>
				s
					? {
							...s,
							integrations: s.integrations.map((i) =>
								i.id === updated.id ? updated : i,
							),
						}
					: s,
			);
			if (restartRequired) setRestartNeeded(true);
		},
		[],
	);

	const applyGithub = useCallback(
		(updated: SetupGithub, restartRequired: boolean) => {
			setStatus((s) => (s ? { ...s, github: updated } : s));
			if (restartRequired) setRestartNeeded(true);
		},
		[],
	);

	const applyRepo = useCallback((updated: Pick<SetupRepo, "id" | "defaultBranch">) => {
		setStatus((s) =>
			s
				? {
						...s,
						repos: s.repos.map((repo) =>
							repo.id === updated.id ? { ...repo, ...updated } : repo,
						),
					}
				: s,
		);
	}, []);

	const restartServer = useCallback(
		async (post = true) => {
			setRestartState("working");
			if (post) {
				try {
					const res = await fetch(`${BASE_PATH}/api/setup/restart`, {
						method: "POST",
					});
					// 409 = nothing would revive this process, so it refused. Say so
					// rather than polling a server that was never going to go down.
					if (res.status === 409) {
						const body = await res.json().catch(() => null);
						setRestartState("idle");
						toast(body?.error || "This server can't restart itself.");
						return;
					}
				} catch {
					// The connection can drop as the server goes down — that's fine,
					// the health poll below is the real signal.
				}
			}
			const deadline = Date.now() + 30_000;
			await sleep(1000);
			while (Date.now() < deadline) {
				try {
					const res = await fetch(`${BASE_PATH}/api/health`, {
						cache: "no-store",
					});
					if (res.ok) {
						await refetch();
						setRestartNeeded(false);
						setRestartState("idle");
						toast("Server restarted. Changes applied.");
						return;
					}
				} catch {}
				await sleep(1000);
			}
			setRestartState("failed");
		},
		[refetch],
	);

	return {
		status,
		failed,
		refetch,
		restartNeeded,
		restartState,
		restartServer,
		applyIntegration,
		applyGithub,
		applyRepo,
	};
}
