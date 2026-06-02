# aamp-openclaw-plugin

OpenClaw plugin that gives an OpenClaw agent an AAMP mailbox identity.

## Install

Requires OpenClaw `>=2026.3.22`. Both `openclaw plugins install` and
`npx aamp-openclaw-plugin init` stop before installation when the detected
OpenClaw version is older.

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

When the plugin starts, it also prints a five-minute `aamp://connect?...`
pairing URL and terminal QR code. Scan it with AAMP App, paste it into User UI,
or run `aamp-cli pair --url ...` to authorize that sender. A valid
`pair.request` writes the sender and optional dispatch-context rules to the
paired sender policy file, then consumes the code. The plugin replies with
`pair.respond`; rejected responses include the failure reason.

You can generate a fresh pairing QR code later without restarting OpenClaw:

- Ask the agent to use the `aamp_pairing_code` tool.
- Ask naturally, for example "发对接码", "生成配对码", or "show the connect QR".
- Or run the `/aamp-pair` command in OpenClaw.

The response includes both the QR target (`https://meshmail.ai/pair?...`) and
the raw `aamp://connect?...` URL for copy/paste pairing.

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
          "taskDispatchConcurrency": 10,
          "slug": "openclaw-agent",
          "credentialsFile": "~/.openclaw/extensions/aamp-openclaw-plugin/.credentials.json",
          "pairingFile": "~/.openclaw/extensions/aamp-openclaw-plugin/.pairing.json",
          "senderPoliciesFile": "~/.openclaw/extensions/aamp-openclaw-plugin/.sender-policies.json",
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

If `senderPolicies` is omitted, no senders are authorized by default. Use the printed pairing QR/URL or configure at least one policy before sending `task.dispatch`; matching policies can also require all configured dispatch-context rules to pass.
`taskDispatchConcurrency` is optional and defaults to `10`.

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
