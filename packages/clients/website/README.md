# Open Session website

The public marketing site is a Next.js app. Its product preview renders the
production Open Session web client inside an iframe with deterministic
browser-side fixtures, so it stays synchronized with the product without
connecting to an instance.

From the repository root:

```sh
bun run website:dev    # http://127.0.0.1:3865
bun run website:build  # production build
```

## Deploy to Vercel

1. Import the `tellahq/opensession` repository.
2. Set **Root Directory** to `packages/clients/website`.
3. Leave the detected framework and build settings as Next.js defaults.
4. Deploy.

The app serves `/`, `/announcement`, `/setup`, and `/product-demo`.
Compatibility rewrites keep `/setup.html` and `/product-demo.html` working for
existing links and capture tooling.

The hero uses animated background artwork from Tella. Before importing the
production app, the iframe replaces `fetch`, `WebSocket`, and `EventSource` with
browser-side fixtures for fixed sessions and transcripts. Cross-origin and
non-API fetches are blocked. Unknown GET API requests return 404, while other
unhandled non-GET API requests receive a fixed `{ "ok": true }` response.
Visitors can navigate the real interface and try the composer without reaching
a real backend.

Agentation is available on `localhost`, `127.0.0.1`, and `.ts.net` hosts when
the viewport is wider than 720px and the primary pointer is not coarse. It is
not rendered on the public website.
