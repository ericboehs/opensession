# Execution nodes

`opensession connect` attaches another machine to your server so sessions can run
*on it*. The reason this exists is platform-locked work: an iOS build needs macOS
with Xcode, a Windows build needs MSVC, and neither can happen on a Linux server.

Sandboxes do not solve this — they are ephemeral Linux containers. A node is a
persistent machine you own.

> **Status.** Attaching a node and running commands on it from a session both
> work. What does not exist yet is relocating a *whole session* to a node — the
> agent still thinks on the server and reaches out to the node for individual
> commands, which is the right shape for "build this over there" and the wrong
> one for "work entirely over there".

## Not a tunnel product

If you have seen `npx t3 connect` or similar, this is a different thing.

Those solve **ingress**: reach my machine from my phone, through NAT, without
setting up a VPN. Their value is avoiding the VPN, which means running a relay
and paying for bandwidth.

This solves **execution**: run this build somewhere that can build it. It
*requires* Tailscale rather than working around its absence — so there is no
relay to operate, no bandwidth bill, and no third party in the path.

## Attaching a machine

On the **server**, mint a code:

```sh
opensession nodes pair
```

```
Pairing code
  WZSU-MMLH
  valid for 10 minutes, single use
```

On the **machine you want to attach** — install OpenSession, then connect:

```sh
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
opensession connect --server http://100.64.12.34:3850 --code WZSU-MMLH
```

```
Connect this machine
  server        http://100.64.12.34:3850
  this machine  studio-mac (darwin/arm64)
  capabilities  xcode, swift, docker, bun
  ok      registered as studio-mac  node-019faffe-8b75-...
```

Then keep it attached:

```sh
opensession node run     # holds the channel open; leave it running
```

Run that under a service manager so the node survives a reboot —
`opensession service install` does the equivalent for the server, and the same
launchd/systemd mechanics apply.

## Using one from a session

Attached nodes show up as tools in interactive sessions. Ask for what you want:

> Build the iOS app on the Mac and tell me if it compiles.

The agent has two tools:

- **`list_nodes`** — what is attached, what each can do, which are online.
- **`run_on_node`** — run a command on one and wait for the result.

A node can be named by id, by name, or by a **unique capability** — asking for
`xcode` resolves to the Mac without the agent knowing its hostname. If a
capability matches more than one node it says so instead of guessing.

Output streams back as the command runs, so a twenty-minute build reports
progress rather than going silent, and very long output is trimmed in the middle
so a build log cannot swallow the agent's context.

If a node is attached but offline — a laptop that went to sleep — the tool says
exactly that rather than hanging.

**These tools are interactive-only.** Automations never receive them. That is
deliberate and it is the main safety property: a node is not sandboxed, so the
difference between "an agent can build on the Mac" and "untrusted ticket text
can run commands on the Mac" is precisely that gate.

## Managing them

```sh
opensession nodes             # what is attached, and when it last checked in
opensession nodes pair        # mint another code
opensession nodes remove <id> # revoke — the credential stops working immediately

opensession node status       # on the node: am I attached, and to what?
```

## Capabilities

`connect` detects what the machine can do and reports it, so a future scheduler
can pick the right one:

| Capability | Detected by |
| --- | --- |
| `xcode` | `xcodebuild -version` succeeds — the stub without full Xcode fails this |
| `swift` | `swift` on PATH |
| `msbuild` | `msbuild` on PATH (Windows) |
| `docker`, `rust`, `go`, `bun` | the tool's binary on PATH (`cargo` for rust) |

## Security

**Attaching a node is equivalent to giving the server a shell on that machine.**
Treat it that way. Four things gate it, and all four are enforced in code rather
than documented as advice:

1. **Tailnet only.** Registration and heartbeat are refused from outside
   Tailscale's `100.64.0.0/10`. A private LAN address does *not* count —
   `192.168.x` is not a trust boundary — and there is a test asserting that, so
   nobody widens it by accident later.
2. **The address comes from the socket, never the request.** A node that could
   name its own address could claim to be on the tailnet from anywhere.
3. **Pairing codes are one-time and expire in ten minutes.** There is no open
   registration endpoint. Codes avoid `0`/`O` and `1`/`I` because people read
   them out loud.
4. **Tokens are stored hashed** and compared in constant time. The plaintext is
   returned exactly once, at registration, and lives in `~/.opensession/node.json`
   (mode 600) on the node. Re-pairing rotates it and invalidates the old one.

Revocation is immediate and it hangs up: `opensession nodes remove` closes any
live channel as well as deleting the record. Authentication happens at connect
time, so deleting the record alone would have left an already-attached node
running commands until its socket happened to drop — which for a machine sitting
in an office is indefinitely. The agent sees the close, recognises the rejection
and exits rather than reconnecting.

The two routes a node uses (`register`, `heartbeat`) are exempt from GitHub
sign-in, because a machine has no browser session — that is what the pairing code
and the token are for. Every operator route (`list`, `pair`, `remove`) still
requires sign-in when it is enabled.

## Troubleshooting

**`registration refused (403)`** — either the code is wrong or expired, or this
machine is not on the tailnet. The two are deliberately indistinguishable in the
response, so check both: `tailscale ip -4` should print a `100.x` address.

**`could not reach <server>`** — the node needs to reach the server, not the
other way around. Verify with `curl <server>/api/health` from the node.

**Node shows "never connected"** — it registered but nothing is heartbeating.
Start `opensession node run`.

**`this node's credential was revoked`** — someone ran `nodes remove`. Re-pair.
