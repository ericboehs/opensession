import { RunnerExecutorAgent, type RunnerExecutorAgentOptions } from "./agent";

/** Explicit daemon entrypoint. Importing this module never dials, spawns, or starts timers. */
export async function startRunnerExecutor(
  options: RunnerExecutorAgentOptions,
): Promise<RunnerExecutorAgent> {
  const agent = new RunnerExecutorAgent(options);
  await agent.start();
  return agent;
}
