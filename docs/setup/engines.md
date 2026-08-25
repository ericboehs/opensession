# Pi engine

Open Session runs every model turn through Pi. Model ids use
`pi/<provider>/<model>`, and bare native ids are normalized to that form before
dispatch.

## Enable Pi

Create `~/.opensession-pi.json`:

```json
{
  "enabled": true,
  "pickerModels": [
    "pi/anthropic/claude-fable-5",
    "pi/anthropic/claude-opus-5",
    "pi/openai/gpt-5.6-sol"
  ]
}
```

You can manage the same setting under **Workspace → Models**. Changes are read
fresh for each turn.

## Accounts

- `pi/anthropic/*` uses the configured Claude subscription account pool.
- `pi/openai/*` uses ChatGPT subscription accounts.
- Other providers use API keys saved under **Workspace → Models → Model providers**.

Provider keys and optional account restrictions are stored in
`~/.opensession-model-providers.json` with mode `0600`.

## Isolation and restarts

Local turns run in detached run-host units. They survive an Open Session service
restart and reconnect on boot. The host receives a minimal environment, guarded
filesystem tools, and only the MCP servers allowed for that run.

Set `OPENSESSION_PI_DETACH=0` only as a rollback measure. Runner-layer changes
need a real `systemctl restart opensession`.
