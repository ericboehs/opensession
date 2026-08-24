/**
 * Executor control protocol: the narrow kernel-to-executor seam used to
 * launch detached local run hosts. It is intentionally not a remote shell.
 * The executor derives every path and command from the host id and validates
 * the already-persisted RunHostSpec before starting anything.
 */

export const EXECUTOR_PROTOCOL_VERSION = 1;
export const EXECUTOR_PROTOCOL_MIN_VERSION = 1;

export function executorSocketPath(sessionsDir: string): string {
  return `${sessionsDir}/executor.sock`;
}

export type ExecutorLaunchState =
  | "starting"
  | "started"
  | "stopped"
  | "failed"
  | "uncertain"
  | "unknown";

export interface ExecutorHostStatus {
  hostId: string;
  specHash?: string;
  unit: string;
  state: ExecutorLaunchState;
  ready: boolean;
  pid?: number;
  error?: string;
}

interface ExecutorRequestBase {
  requestId: string;
  token: string;
}

export type ExecutorRequest =
  | (ExecutorRequestBase & {
      t: "hello";
      minVersion: number;
      maxVersion: number;
    })
  | (ExecutorRequestBase & {
      t: "launch_host";
      version: number;
      hostId: string;
      specHash: string;
    })
  | (ExecutorRequestBase & {
      t: "host_status";
      version: number;
      hostId: string;
      specHash?: string;
    })
  | (ExecutorRequestBase & {
      t: "stop_host";
      version: number;
      hostId: string;
      specHash: string;
    });

export type ExecutorResponse =
  | {
      requestId: string;
      ok: true;
      version: number;
      compatible?: boolean;
      status?: ExecutorHostStatus;
    }
  | {
      requestId: string;
      ok: false;
      version: number;
      code:
        | "unsupported_version"
        | "invalid_request"
        | "invalid_host"
        | "spec_not_found"
        | "spec_hash_mismatch"
        | "launch_failed"
        | "launch_uncertain"
        | "executor_busy"
        | "stop_failed";
      error: string;
    };
