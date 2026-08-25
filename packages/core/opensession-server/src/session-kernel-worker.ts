import { startSessionKernelActorWorker } from "./server/session-kernel/actor-worker";

const lane = new URL(import.meta.url).searchParams.get("opensessionKernelLane");
startSessionKernelActorWorker({ recoverCentralCommands: lane !== "session" && lane !== "migration" });
