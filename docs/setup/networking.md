# Networking: keeping Open Session private

**Open Session has no built-in authentication.** It trusts everyone who can
reach the address it binds to. The "user" in the UI is a self-selected display
name in localStorage — it drives attribution and per-user tool scoping, not
access control.

That is a deliberate design choice, not an oversight: safety comes from
least-privilege scoping of what *runs* can do, and from only being reachable on
a private network. The second half is your job.

Anyone who reaches it can start sessions that execute code on your box, read
every repository you have registered, and use your model subscriptions. Treat
the bind address as the security boundary.

## The short version

| | |
| --- | --- |
| Default | binds `127.0.0.1` — reachable only from the box itself |
| Sharing with a team | bind a **Tailscale** IP |
| Occasional access | leave it on `127.0.0.1`, use an **SSH tunnel** |
| Never | `HOST=0.0.0.0`, a public port, or a reverse proxy without auth |

## Tailscale (recommended)

[Tailscale](https://tailscale.com) puts your machines on a private WireGuard
network. Devices reach each other; nothing else can. The free tier covers a
small team.

### 1. Install it on the box

For a fresh Open Session install on Linux, pass `--tailscale` to the downloaded
script after `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --tailscale
```

The Open Session installer only installs Tailscale automatically when
passwordless `sudo` is available. If it reports that `sudo` is needed, or if
Open Session is already installed, add Tailscale directly. You do not need to
reinstall Open Session:

```sh
curl -fsSL https://tailscale.com/install.sh | sh
```

On macOS, use the [Tailscale download page](https://tailscale.com/download/mac).
Check with `tailscale ip -4`; if it prints a `100.x` address, you are already on
a tailnet and can skip to step 3.

### 2. Join your network

```sh
sudo tailscale up
```

It prints a URL — open it and authenticate. On a headless box, use
`sudo tailscale up --ssh` if you also want Tailscale SSH.

This is the step the installer cannot do without your account. For an
unattended fresh install, it can join with a Tailscale [auth
key](https://tailscale.com/kb/1085/auth-keys):

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | TS_AUTHKEY=tskey-auth-... bash -s -- --tailscale
```

The environment variable belongs before `bash`, not before `curl`, so the
installer receives it. See [Install with Tailscale](install.md#install-with-tailscale).

### 3. Disable key expiry for the server

Tailscale node keys expire by default, which can disconnect an unattended
server until someone signs in again. In the [Tailscale admin
console](https://login.tailscale.com/admin/machines), open **Machines**, find
the Open Session server, open its **…** menu, and choose **Disable key
expiry**.

Do this for the trusted server, not automatically for every device. Disabling
expiry means a stolen server identity remains valid until you revoke it. See
[Tailscale's key expiry documentation](https://tailscale.com/kb/1028/key-expiry).

### 4. Find the tailnet address

```sh
tailscale ip -4        # e.g. 100.64.12.34
```

### 5. Bind Open Session to it

If you joined the tailnet *before* onboarding, this is already done — the
wizard offers the tailnet address as the bind default. Otherwise:

```sh
opensession bind
```

That is the whole fix: it rewrites the bind address (and the public base URL,
when it still pointed at the old address) in both `~/.opensession/config.json`
and `~/.opensession.env`, then restarts the service — the bind address is the
one setting a live config re-read cannot apply. `opensession bind <ip>` names
an address explicitly, for boxes that are not on a tailnet.

Then reach it from any device on the tailnet at `http://<tailnet-ip>:3850`.

If you manage the files by hand instead, change `HOST` in
`~/.opensession.env` (it overrides `server.host` in config.json), set
`OPENSESSION_UI_BASE` to match — or links posted into Slack, Linear and notes
will point somewhere unreachable — and restart.

### 6. Install Tailscale on the devices you want to use

Phone, laptop, whatever. They must be on the same tailnet. That is the whole
access-control story — adding a device to the tailnet grants access, removing
it revokes access.

### Nicer URLs and HTTPS

MagicDNS gives the box a stable name, and Tailscale can issue a real
certificate for it:

```sh
sudo tailscale cert <machine>.<tailnet>.ts.net
```

Point a local reverse proxy (Caddy, nginx) at `127.0.0.1:3850` using that
certificate. This is how Tella runs it. Note that a proxy does not add
authentication — it only adds TLS. Reachability is still whatever the proxy
binds to, so bind the proxy to the tailnet address too.

### Verify you are actually private

```sh
# What is Open Session listening on? Should be 127.0.0.1 or a 100.x tailnet IP.
ss -tlnp | grep -E '3850|3860'

# From somewhere off the tailnet (your phone on cellular, a cloud shell):
curl -m 5 http://<public-ip>:3850/    # must fail
```

On a cloud box, also check the firewall — the security group or firewall rules
should not open 3850 or 3860 directly. Funnel, Cloudflare Tunnel, or Caddy
terminates TLS in front of loopback 3860. See [ec2.md](ec2.md#networking).

## A custom domain (os.company.dev)

`http://100.64.12.34:3850` works but is unpleasant to type and impossible to
remember. You can put a real name and a real certificate in front of it without
exposing anything.

The trick is that **a public DNS record may point at a private address.** Anyone
can resolve `os.company.dev` to `100.64.12.34`; only devices on your tailnet can
reach it. Publishing the name costs you nothing, because the name was never the
security boundary — reachability is.

### 1. Point the name at the tailnet address

```sh
tailscale ip -4        # e.g. 100.64.12.34
```

Create an **A record** for `os.company.dev` with that value, at whatever DNS
provider you use. An A record, not a CNAME — you are pointing at an address, and
a CNAME would need something else already resolving to it.

(If you would rather not publish the mapping at all, Tailscale's MagicDNS gives
you `<machine>.<tailnet>.ts.net` for free with no public record. You lose the
custom name and gain slightly more privacy.)

### 2. Get a certificate

Your host is not reachable from the internet, so the usual HTTP-01 ACME
challenge cannot work — Let's Encrypt cannot connect to it. Use **DNS-01**,
which proves control of the domain by writing a TXT record instead.

With [lego](https://go-acme.github.io/lego/) and, say, Cloudflare DNS:

```sh
CLOUDFLARE_DNS_API_TOKEN=... lego \
  --email you@company.dev \
  --dns cloudflare \
  --domains os.company.dev \
  run
```

Most providers have a lego plugin; Caddy and Traefik can also do DNS-01
themselves with the matching plugin, which avoids running lego separately.

Renewal is the part people forget — put it on a timer.

### 3. Terminate TLS in front of the server

Keep Open Session on `127.0.0.1:3850` and let a proxy hold the certificate.
Caddy, bound to the tailnet address:

```caddy
os.company.dev {
    bind 100.64.12.34
    tls /etc/lego/certificates/os.company.dev.crt /etc/lego/certificates/os.company.dev.key
    reverse_proxy 127.0.0.1:3850
}
```

The `bind` line is the important one. Without it Caddy listens on every
interface, which quietly undoes the whole arrangement — the certificate makes it
look secure while the port is open to the world.

**A TLS proxy adds encryption, not authentication.** Anything that can reach the
proxy can use Open Session.

### 4. Tell Open Session its own name

```sh
# ~/.opensession.env
OPENSESSION_UI_BASE=https://os.company.dev
```

Links posted into Slack, Linear and notes are built from this. Get it wrong and
everything works except that every link you share points somewhere unreachable.

The clients (Chrome extension, Electron shell, Swift app) each take a server
address too — see [instance-configuration.md](../instance-configuration.md).

### 5. Check it from outside

```sh
# on the tailnet
curl -I https://os.company.dev

# off the tailnet — must fail to connect, NOT return 401
curl -m 5 -I https://os.company.dev
```

A connection timeout is the correct result. A `401` would mean the port is open
to the internet and only a login stands in the way, which is a different and
much weaker position.

## SSH tunnel

If you are the only user and only need occasional access, skip Tailscale:

```sh
ssh -L 3850:127.0.0.1:3850 user@box
# then open http://127.0.0.1:3850 locally
```

Nothing is exposed; the tunnel exists only while the SSH session does.

## If you must expose it more widely

Turn on real authentication first. `integrations.github` adds GitHub sign-in:
every `/api/*` request and the UI WebSocket require a session cookie, and only
logins listed in `identity.team` can sign in. See
[github.md](github.md#per-user-github-auth-prs-as-the-session-owner).

Even then, prefer keeping the network boundary. Sign-in protects the UI and
API; it is not a reason to put an agent runner on the public internet.

## Public ingress is separate

Open Session binds one fail-closed public gateway on `127.0.0.1:3860`. It
serves exact registered webhook and OAuth routes, remote Sandbox WebSockets,
and workload identity. Unknown methods and paths return 404. The private app
on 3850 is not part of this listener and must not be routed through the public
origin.

Every webhook route still verifies its provider signature
(`GITHUB_WEBHOOK_SECRET`, `LINEAR_WEBHOOK_SECRET`, `PLAIN_WEBHOOK_SECRET`,
`STRIPE_WEBHOOK_SECRET`). The network boundary and signature checks are both
required.

Configure the canonical origin in Settings → Public ingress or directly:

```json
{
  "server": {
    "publicBaseUrl": "https://sessions.tailnet.example.com"
  },
  "ingress": {
    "publicBaseUrl": "https://ingress.example.com",
    "exposure": "custom"
  }
}
```

`OPENSESSION_INGRESS_BASE` overrides the configured ingress URL. Setup guides,
webhook URLs, remote Sandbox callbacks, and the workload-identity issuer all
use this origin. Session links and authenticated app callbacks continue to use
the independent private app origin.

### Tailscale Funnel

Choose Tailscale Funnel in Settings for automatic HTTPS without DNS records or
inbound firewall ports. Open Session routes the machine's `*.ts.net` Funnel
hostname to `127.0.0.1:3860`. Funnel cannot serve a custom hostname.

### Cloudflare Tunnel

Create a named tunnel, then enter its UUID, connector token and public URL in
Settings. Open Session stores the token write-only, runs `cloudflared` with the
token file, and restarts the connector if it exits. Point the public hostname
at the tunnel and set its only service to:

```text
http://127.0.0.1:3860
```

The required DNS record is:

```text
CNAME ingress.example.com <tunnel-id>.cfargotunnel.com
```

Only the ingress gateway belongs in the tunnel. Never add port 3850 unless you
have separately decided to make the authenticated app public.

### Custom domain with Caddy

Point the hostname's A/AAAA records at the server, then choose Custom domain in
Settings. Open Session writes its marked Caddy section, validates the complete
Caddyfile, reloads Caddy, verifies the public health route, and restores the
prior file on failure. The resulting site is intentionally simple because the
application owns the exact public route allowlist:

```caddy
ingress.example.com {
    handle {
        reverse_proxy 127.0.0.1:3860
    }
}
```

The maintained example lives at `deploy/caddy/sandbox-ingress.caddy.example`.
