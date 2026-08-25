# Open Session server

The Bun HTTP/WebSocket gateway and React web client live in this package
alongside separately launched runtime processes.

- `opensession.ts` is the source gateway entrypoint.
- `src/session-kernel-service.ts` starts the required service that owns
  authoritative session state.
- `src/main.ts` dispatches the gateway and other process roles in compiled builds.
- `src/server/` owns HTTP, WebSocket, runner, automation, and persistence code.
- `src/frontend/` is the React web client built and served by the gateway.
- `src/runner-host/` contains the one-run host and MCP proxy entrypoints plus
  shared protocol, spawn, relay, and transport support. Run hosts execute outside
  the gateway in local transient units, sandboxes, and connected Runners.

Run commands from the repository root so workspace dependencies, patches, and
repository-relative deployment paths resolve consistently:

```sh
bun install
bun run opensession start --foreground
bun run typecheck
bun run test
```
