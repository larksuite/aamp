# aamp-openclaw-plugin

OpenClaw plugin that gives an OpenClaw agent an AAMP mailbox identity.

## Install

```bash
npm install aamp-openclaw-plugin
```

When installed via:

```bash
npx aamp-openclaw-plugin init
```

the installer will prompt for:

- `AAMP Host`
- `Primary trusted dispatch sender`
- optional `Dispatch context rules`

The answers are written into the OpenClaw plugin config automatically, so users do not need to hand-edit `openclaw.json`.

## Build

```bash
npm run build
```

## OpenClaw config

```json
{
  "plugins": {
    "entries": {
      "aamp-openclaw-plugin": {
        "enabled": true,
        "config": {
          "aampHost": "https://meshmail.ai",
          "slug": "openclaw-agent",
          "credentialsFile": "~/.openclaw/extensions/aamp-openclaw-plugin/.credentials.json",
          "senderPolicies": [
            {
              "sender": "meegle-bot@meshmail.ai",
              "dispatchContextRules": {
                "project_key": ["proj_123"],
                "user_key": ["alice"]
              }
            }
          ]
        }
      }
    }
  }
}
```

If `senderPolicies` is omitted, all senders are accepted. If set, the dispatch sender must match one policy and all configured dispatch-context rules for that sender must pass.

The plugin also understands:

- dispatch priority via `X-AAMP-Priority`
- dispatch expiry via `X-AAMP-Expires-At`
- sender-side cancellation via `task.cancel`
- realtime streaming via `task.stream.opened` + SSE-compatible stream events

When multiple tasks are pending locally, the plugin schedules them in this order:

1. `urgent`
2. `high`
3. `normal`

Within the same priority, tasks are processed FIFO by receive time. On startup, the plugin reconciles recent mailbox history so that still-valid tasks can be recovered after the agent was offline.

While a task is running, the plugin now:

1. creates a task stream
2. sends `task.stream.opened`
3. emits `status`, `progress`, and `text.delta` events
4. closes the stream before sending `task.result` or `task.help_needed`
