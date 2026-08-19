# Open Session website

The public marketing site is a separate entry from the authenticated
Open Session app. Its product preview renders the production app inside an
iframe with deterministic browser-side fixtures, so the UI stays synchronized
with the product without connecting to an Open Session instance.

```sh
bun run website:dev    # http://127.0.0.1:3865
bun run website:build  # writes .website-dist/
```

Deploy the contents of `.website-dist/` as a static site. The build always
emits stable `index.html`, `setup.html`, `setup/index.html`, `product-demo.html`, and `opensession-social.png`
paths; scripts, styles, and the in-page icon remain content-hashed.

The hero uses animated background artwork from Tella. The iframe overrides
`fetch` and `WebSocket` before importing the production app, serves fixed
sessions and transcripts, and fails closed for unknown API requests. Visitors
can navigate the real interface and try the composer without reaching a real
backend.

Agentation is available on localhost and tailnet staging hosts for visual
feedback. It is not rendered on the public website.
