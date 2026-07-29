# Networking: keeping OpenSession private

**OpenSession has no built-in authentication.** It trusts everyone who can
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

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

It prints a URL — open it and authenticate. On a headless box, use
`sudo tailscale up --ssh` if you also want Tailscale SSH.

### 2. Find the tailnet address

```sh
tailscale ip -4        # e.g. 100.64.12.34
```

### 3. Bind OpenSession to it

```sh
opensession stop
# set HOST in ~/.opensession.env, or server.host in ~/.opensession/config.json
sed -i "s/^HOST=.*/HOST=$(tailscale ip -4)/" ~/.opensession.env
opensession start
```

Then reach it from any device on the tailnet at `http://<tailnet-ip>:3850`.

Set `OPENSESSION_UI_BASE` to the same address, or links posted into Slack,
Linear and notes will point somewhere unreachable.

### 4. Install Tailscale on the devices you want to use

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
# What is OpenSession listening on? Should be 127.0.0.1 or a 100.x tailnet IP.
ss -tlnp | grep -E '3850|3848'

# From somewhere off the tailnet (your phone on cellular, a cloud shell):
curl -m 5 http://<public-ip>:3850/    # must fail
```

On a cloud box, also check the firewall — the security group or firewall rules
should not open 3850 or 3848 at all. See [ec2.md](ec2.md#networking).

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
[github.md](github.md#per-user-github-auth--web-sign-in).

Even then, prefer keeping the network boundary. Sign-in protects the UI and
API; it is not a reason to put an agent runner on the public internet.

## The webhook server is separate

The webhook server (default port **3848**) is a second HTTP listener for
inbound GitHub, Linear, Plain and Stripe events. If you use those integrations,
*that* port needs to be reachable by the provider — which means it cannot live
on the tailnet alone.

Expose 3848 only, never 3850, and only through something that terminates TLS.
Every webhook route verifies a signature (`GITHUB_WEBHOOK_SECRET`,
`LINEAR_WEBHOOK_SECRET`, `PLAIN_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`), so
set those — an unsigned webhook endpoint is an open door into your automations.

If you do not use inbound webhooks, leave 3848 on `127.0.0.1` and forget it
exists.
