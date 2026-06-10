# Backstage audit logs

Backstage keeps a structured audit trail of every agent run, modeled on
`tellahq/incident-agent` (`src/audit.ts` there, `src/server/audit.ts` here).

## What gets logged

Every `runClaude` invocation emits `claude_turn_event` JSON lines to
`~/.backstage-audit/audit-YYYY-MM-DD.jsonl`:

- `user_prompt` (direction `in`) — run key, backstage session, run kind
  (interactive / automation / resume), mode, cwd, MCP allowlist, denied
  tools, AWS-creds flag.
- `assistant_text` / `assistant_thinking` — what the model said/thought.
- `tool_use` — tool name + input snippet; `tool_result` — output + `is_error`.
- `permission_decision` — every canUseTool deny (denied tools, headless
  AskUserQuestion) and AskUserQuestion outcomes.
- `result` — subtype, duration, turns, token usage, cost.
- `error` / `cancelled` / `account_switch`.

Bodies are stored as sha256 + bounded snippet (300 bytes; 500 for tool
inputs), like incident-agent: small logs, but every entry can be reconciled
against the full Claude session jsonl on disk. Local files are pruned after
400 days to match incident-agent's CloudWatch retention.

## Shipping to CloudWatch (one-time setup, needs admin)

incident-agent ships stdout via Docker's `awslogs` driver. Backstage runs as
a systemd unit that hard-denies IMDS (`backstage.service`), so the app can
never hold AWS credentials — instead the standalone amazon-cloudwatch-agent
(its own systemd service, IMDS allowed) tails the audit files into the
`/tella/backstage/prod` log group.

The `michael-ai` instance role only has `ReadOnlyAccess` + SSM by default.
The audit-log write policy (scoped to `log-group:/tella/backstage/*`) is
managed in Terraform: `tellahq/shared-infra`, `components.tfcomponent.hcl`,
component `michael_instance_profile` → `inline_policies.backstage-audit-logs`
(added in shared-infra#55).

Then install and start the agent on the VPS (needs sudo):

```bash
wget https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/$(dpkg --print-architecture)/latest/amazon-cloudwatch-agent.deb
sudo dpkg -i amazon-cloudwatch-agent.deb
sudo cp deploy/cloudwatch-agent-backstage.json \
  /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/backstage.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/backstage.json
```

Verify (the VPS is in eu-west-2 — unlike the rest of Tella — and the agent
ships to the instance's own region, so the log group lives there):

```bash
aws logs tail /tella/backstage/prod --region eu-west-2 --since 10m
```

## Querying

CloudWatch Logs Insights examples:

```
# What did automations run, and what did they cost?
filter msg = "claude_turn_event" and kind = "result"
| stats count(*), sum(total_cost_usd) by run_kind

# Every tool call in a session
filter msg = "claude_turn_event" and kind = "tool_use" and bks_session_id = "..."
| sort @timestamp asc
| display @timestamp, tool_name, text_snippet
```

Locally the same questions are one `jq` away over
`~/.backstage-audit/audit-*.jsonl`.
