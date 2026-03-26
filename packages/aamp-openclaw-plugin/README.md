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
              "sender": "platform-bot@meshmail.ai",
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
