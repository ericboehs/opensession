# OpenSession website

The public marketing site is a separate frontend from the authenticated
OpenSession app. It deliberately imports no app APIs, WebSocket hooks, or auth
code, so the static output can be hosted on a public origin while OpenSession
instances stay private.

```sh
bun run website:dev    # http://127.0.0.1:3865
bun run website:build  # writes .website-dist/
```

Deploy the contents of `.website-dist/` as a static site. The build always
emits stable `index.html` and `opensession-social.png` paths; scripts, styles,
and the in-page icon remain content-hashed.

The hero uses animated background artwork from Tella. The product image
is a sanitized capture of the real OpenSession web interface rather than a
separate marketing mock.
