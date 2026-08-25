# Open Session audit logs

Open Session keeps a structured audit trail of every agent run
(`packages/core/opensession-server/src/server/audit.ts`): one JSON line per event, in a daily file.

## What gets logged

Every engine run (`packages/core/opensession-server/src/server/pi-runner.ts`) emits `claude_turn_event`
JSON lines (the event name predates the single-engine consolidation and is
kept for log continuity) to `~/.opensession-audit/audit-YYYY-MM-DD.jsonl`.
Every line carries the run key, session id, run kind, mode, and model; the
main event kinds:

- `user_prompt` (direction `in`) — cwd, the run's MCP servers, and (on
  least-privilege unattended runs) the denied tools stripped from the
  model's tool list.
- `assistant_text` / `assistant_thinking` — what the model said/thought.
- `tool_use` — tool name + input snippet; `tool_result` — output + `is_error`.
- `permission_decision` — every permission-ask outcome: tool, allow/deny,
  and why (unattended auto-reject, interactive auto-approve, human decision).
- `result` — subtype, token usage, cost.
- `error` / `cancelled` / `account_switch`, plus run-lifecycle events such
  as `steer_injected`, `reattach`, `context_rebuild`, and `provider_retry`.

Bodies are stored as sha256 + bounded snippet (300 bytes; 500 for tool
inputs): small logs, but every entry can be reconciled against the full
engine transcript on disk. Local files are pruned after 400 days, matching
the retention in the example CloudWatch shipping config.

The other engines keep the same discipline under their own event families:
one `in`/`out` pair per turn, plus a denial event when the deny-by-default
kind gate refuses a run. The pi engine logs `pi_turn` / `pi_gate_denied`,
`pi_mcp_call` per bridged MCP call, and paired `pi_command_start` /
`pi_command_finish` events for each local bash command. Command events retain
only a sha256, byte count, safe command category, literal `sleep` duration
when parseable, and execution outcome. They never retain command text. The
Claude Agent SDK engine logs
`claude_direct_turn` / `claude_direct_gate_denied`, and the Codex engine
logs `codex_direct_turn` / `codex_direct_gate_denied`.

## Shipping to CloudWatch (optional, one-time setup, needs admin)

Open Session runs as a systemd unit that hard-denies IMDS
(`opensession.service`), so the app itself can never hold AWS credentials —
instead the standalone amazon-cloudwatch-agent (its own systemd service,
IMDS allowed) tails the audit files into a log group. The example config
`deploy/cloudwatch-agent-opensession.json` ships to `/opensession/prod`; edit
its `file_path` to your audit dir (the default is `~/.opensession-audit/`,
written as an absolute path) and pick your own log group name.

Give the instance role write access to that log group only
(`logs:CreateLogGroup`/`CreateLogStream`/`PutLogEvents` scoped to it) —
keep the rest of the role least-privilege.

Then install and start the agent on the host (needs sudo):

```bash
wget https://amazoncloudwatch-agent.s3.amazonaws.com/ubuntu/$(dpkg --print-architecture)/latest/amazon-cloudwatch-agent.deb
sudo dpkg -i amazon-cloudwatch-agent.deb
sudo cp deploy/cloudwatch-agent-opensession.json \
  /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/opensession.json
sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \
  -a fetch-config -m ec2 -s \
  -c file:/opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.d/opensession.json
```

Verify (the agent ships to the instance's own region, so the log group
lives there — even if the rest of your infrastructure is elsewhere):

```bash
aws logs tail /opensession/prod --region <instance-region> --since 10m
```

## Querying

CloudWatch Logs Insights examples:

```
# What did automations run, and what did they cost?
filter msg = "claude_turn_event" and kind = "result"
| stats count(*), sum(total_cost_usd) by run_kind

# Every tool call in a session
filter msg = "claude_turn_event" and kind = "tool_use" and session_id = "..." (events before 2026-08-05 use bks_session_id)
| sort @timestamp asc
| display @timestamp, tool_name, text_snippet
```

Locally the same questions are one `jq` away over
`~/.opensession-audit/audit-*.jsonl`.
