# Open Session server

The Bun server and the web client it serves live together in this package.

- `opensession.ts` is the server entrypoint.
- `src/server/` owns HTTP, WebSocket, runner, automation, and persistence code.
- `src/frontend/` is the React web client built and served by the server.
- `src/runner-host/` is the detached run-host process.

Run commands from the repository root so workspace dependencies, patches, and
repository-relative deployment paths resolve consistently:

```sh
bun install
bun run start
bun run typecheck
bun run test
```
