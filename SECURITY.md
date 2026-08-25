# Security

## Reporting a vulnerability

Use **[GitHub private vulnerability reporting](https://github.com/tellahq/opensession/security/advisories/new)**
— the Security tab → Report a vulnerability. It is private between you and the
maintainers, and it gives us a place to work on a fix and credit you when it
ships.

Please do not open a public issue for a security problem. If private reporting
is unavailable to you for any reason, open a normal issue saying only that you
have a security report and would like a private channel — no details — and we
will get you one.

Useful things to include: what an attacker can do, the smallest reproduction you
have, and which version or commit you tested. A working proof of concept is
welcome but never required — a clear description of the mechanism is worth more
than an exploit.

We aim to acknowledge within a few days. This is a small team, so please tell us
if you have a disclosure deadline and we will be straight with you about whether
we can meet it.

## Read this before reporting: the trust model

**Open Session has no built-in authentication by default, and that is a design
choice rather than a bug.** It binds to `127.0.0.1` and trusts whoever can reach
that address. The "user" in the UI is a self-selected display name — attribution,
not access control.

So the following are **not** vulnerabilities:

- "Anyone who can reach the server can use it." Yes. The bind address is the
  security boundary; see [docs/setup/networking.md](docs/setup/networking.md).
- "I set `HOST=0.0.0.0` and now the internet can use it." That is the documented
  wrong thing to do.
- "A session can run arbitrary commands." That is the product. A session is an
  agent with a shell, and attaching an execution node is explicitly described as
  equivalent to handing over a shell on that machine.
- "The API accepts a `user` field I can set." When sign-in is off, yes — it is a
  display name. When sign-in is on, the verified identity overrides it, and a
  case where it does *not* would be a real finding.

Optional GitHub sign-in ([docs/setup/github.md](docs/setup/github.md)) adds real
authentication on top. Turning it on does not make the server safe to expose
publicly, and we do not claim it does.

## What we do consider a vulnerability

The interesting boundary is **untrusted input reaching privileged capability**.
Agent runs process text we did not write — customer support tickets, pull-request
diffs, issue bodies, web pages — and the guarantee is that this text is *data*,
never instructions that can widen what a run may do.

Anything that breaks that is in scope, especially:

- **Escaping least-privilege scoping.** An automation run reaching a tool, MCP
  server, credential or environment variable it was not granted. Automation runs
  get a minimal environment with none of your tokens, a per-automation MCP
  allowlist, and hard-denied customer-facing and identity-mutating tools.
- **Reaching interactive-only tools from an automation.** The
  `opensession-sessions`, `opensession-admin` and `opensession-nodes` servers are
  interactive-only precisely because they can steer other sessions, reconfigure
  the instance, or run commands on an attached machine. A path from automation
  input to any of those is a serious finding.
- **Prompt injection that crosses a real boundary.** Text in a diff or a ticket
  persuading an agent to *say* something is not a vulnerability; text that causes
  it to exfiltrate a credential, post as a user, mutate an account, or move money
  is. The money-moving Stripe tools are stripped from the model's tool list
  rather than merely discouraged — a way to reach them would be critical.
- **Bypassing the execution-node gates.** Registering a node from outside the
  tailnet, using a revoked node's credential, or reaching `run_on_node` from an
  automation. See [docs/nodes.md](docs/nodes.md#security).
- **Credential disclosure.** Tokens in logs, in API responses, in generated
  config, in error messages, or committed to a repository. We treat a leaked
  credential prefix in terminal output as a real bug — it has happened here
  before.
- **Authentication bypass when sign-in is enabled.** Reaching an authenticated
  route without a session, or acting as another user.
- **Sandbox escape** where a sandbox is claimed to isolate. Note the honest
  scoping in
  [docs/self-hosting-sandboxes.md](docs/self-hosting-sandboxes.md#security-posture-what-a-sandbox-does-and-doesnt-isolate)
  — we do not claim more than we deliver.

## Out of scope

- Anything requiring the attacker to already be inside the trust boundary you
  chose (on your tailnet, signed in, or with shell on the host).
- Denial of service by an authorised user. An agent can spend your money and fill
  your disk; that is inherent to running one.
- Vulnerabilities in a model provider, in Pi, or in an MCP server you
  configured — report those upstream, though do tell us if our integration makes
  them materially worse.
- Missing hardening headers on a server documented as private-network-only.
- Findings from a scanner with no demonstrated impact.

## Supported versions

This is young software with no release branches yet. Fixes land on the default
branch; if you are self-hosting, `opensession update` is the upgrade path. When
that changes, this section will say so.

## For operators

If you run Open Session, the highest-value things you can do:

1. **Keep it off the public internet.** [networking.md](docs/setup/networking.md)
   — and verify from *outside* your network, which is the only check that proves
   anything.
2. **Set webhook signing secrets** if you expose the webhook port. An unsigned
   webhook endpoint is an open door into your automations.
3. **Scope your automations.** Give each the smallest MCP allowlist that works,
   and prefer `ask` mode unless it must write.
4. **Only enable `selfImprove`** on scheduled automations that read your own
   telemetry — never on anything triggered by untrusted input.
5. **Treat an attached node as a shell** on that machine, because it is.
