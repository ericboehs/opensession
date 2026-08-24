# Open Session website

The public marketing site is a Next.js app. Its product preview renders the
production Open Session web client inside an iframe with deterministic
browser-side fixtures, so it stays synchronized with the product without
connecting to an instance.

```sh
bun run website:dev    # http://127.0.0.1:3865
bun run website:build  # production build
```

## Deploy to Vercel

1. Import the `tellahq/opensession` repository.
2. Set **Root Directory** to `packages/clients/website`.
3. Leave the detected framework and build settings as Next.js defaults.
4. Deploy.

The app serves `/`, `/setup`, and `/product-demo`. Compatibility rewrites keep
`/setup.html` and `/product-demo.html` working for existing links and capture
tooling.

The hero uses animated background artwork from Tella. The iframe overrides
`fetch` and `WebSocket` before importing the production app, serves fixed
sessions and transcripts, and fails closed for unknown API requests. Visitors
can navigate the real interface and try the composer without reaching a real
backend.

Agentation is available on localhost and tailnet staging hosts for visual
feedback. It is not rendered on the public website.
