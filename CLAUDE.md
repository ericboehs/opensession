Default to using Bun instead of Node.js.

- Use `bun run backstage.ts` to start the server
- Server binds to Tailscale IP (100.65.135.7:3850) — not publicly accessible
- Access at `http://michael:3850/backstage/`
- Bun automatically loads .env, so don't use dotenv
- HTML imports for frontend bundling (no Vite)
- All session file access is read-only (never modify ~/.slack-sessions/ or ~/.linear-sessions/)
- Own session store at ~/.backstage-sessions/
