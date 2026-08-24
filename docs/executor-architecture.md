# Executor architecture

Open Session separates run-host launch policy from the process that owns the
web UI, session queues, and durable transcript. This is the first deployment
boundary in the gateway, kernel, executor architecture.

```text
Clients -> Open Session gateway and kernel -> executor launcher -> run host
                                             |                 -> engine
                                             + fixed policy
```

The Open Session process remains the session kernel. It owns prompt admission,
queues, asks, run journals, transcript writes, WebSocket broadcasts, and final
bookkeeping. The executor launcher can only start, inspect, or stop a detached
local run host from a persisted `RunHostSpec`. It cannot execute an arbitrary
command, accept an arbitrary path, or change systemd properties.

## Control protocol

The kernel and executor communicate over `executor.sock` in the active session
state directory. The socket is mode `0600`. Messages are newline-delimited JSON
using `@tellahq/opensession-protocol/executor`.

Every request carries a request id. Launches are idempotent by host id and the
SHA-256 hash of the persisted spec. Reusing a host id with different spec bytes
is rejected. Major protocol versions are negotiated before launch and an
incompatible service fails closed.

Linux units receive a shared bearer token through systemd credentials. The
token prevents detached run-host units from using the control protocol through
the normal launch environment. It is defense in depth, not a hard isolation
boundary: the gateway, executor, and local agents still use one Unix identity.
A future executor security boundary requires run hosts to use a distinct
identity or the executor to authenticate peer processes through the kernel.

The executor persists its launch record inside the host directory before it
calls a root-owned helper. That helper validates the host id, state directory,
and spec hash before applying a fixed `systemd-run` policy. The installer grants
the service user passwordless sudo for this helper only. If the executor
restarts while a launch is in progress, the next request reconciles the existing
unit and host socket instead of starting a second run.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Executor unavailable before launch | Launch fails closed; direct launch requires the explicit `OPENSESSION_EXECUTOR=0` operator bypass |
| Executor incompatible | New launch fails; no direct fallback |
| Executor disconnects after launch request | Kernel checks the host locally, then preserves recovery state if still uncertain |
| Executor restarts during an active run | Run host and engine continue; the kernel remains attached directly |
| Kernel restarts during an active run | Existing run-host journal and socket reattachment recover the turn |

The executor is not the parent of active run hosts. Hosts run in transient
systemd units, so restarting `opensession-executor.service` affects only launch
requests currently crossing the control socket.

## Deployment

Linux installs two independent units:

- `opensession.service`: gateway, session kernel, schedulers, and projections.
- `opensession-executor.service`: local run-host launch policy.

The main unit wants the executor but does not require or own it. There is no
`PartOf=` relationship. An executor-only deployment restarts only the executor.
Mixed changes drain the main service before replacing the executor, then restart
the main service against the new launcher.

Self-deploy restarts an executor that was installed by
`opensession service install`, but does not copy privileged units or helpers from the writable
checkout. Run the service installer again when a release changes those system
artifacts. Instances intentionally operating without the executor must set
`OPENSESSION_EXECUTOR=0`; an unavailable configured executor never silently
changes launch paths.

During the first upgrade only, installations that already granted the previous
fixed `systemd-run` launch command keep using it until the service installer
puts the root-owned helper in place.

Set `OPENSESSION_EXECUTOR=0` to deliberately bypass the sidecar for new launches. Existing
run hosts are unaffected.

Detached local hosts require Linux with a booted systemd and the installed
run-host helper. Other platforms keep using the in-process runner.

## Scope

The executor is an independently restartable launch-policy boundary, not a hard
security sandbox. Its unit does not load the application EnvironmentFile and
receives only path settings plus its systemd credential directory. The gateway,
executor and run hosts still share one Unix identity; a future privilege boundary
requires a distinct executor identity and peer credentials.

Normal production launch has one path through the executor. The direct fixed
helper remains only as an explicit operator bypass for recovery and development.
Active hosts are still controlled directly through their private host protocol;
the executor is not their parent and does not own session lifecycle.

## Rollback compatibility

The session-kernel schema has a tracked compatibility version. Self-deploy records
the highest schema that may have opened the durable database before restarting
the gateway, and refuses an automatic rollback to a revision with an older or
missing reader. This turns an unsafe rollback into an explicit operator action
instead of letting an old binary replay indeterminate physical work.
