# aamp-acp-bridge

Config-driven bridge that connects ACP-compatible agents to the AAMP email network.

## Install

```bash
npm install aamp-acp-bridge
```

## Usage

Initialize a config file:

```bash
npx aamp-acp-bridge init
```

Start the bridge:

```bash
npx aamp-acp-bridge start --config bridge.json
```

By default, agent credentials are stored under `~/.acp-bridge/`.

The bridge understands these task lifecycle intents:

- `task.dispatch`
- `task.stream.opened`
- `task.help_needed`
- `task.result`
- `task.cancel`

Dispatch tasks can also carry:

- `priority`: `urgent | high | normal`
- `expiresAt`: an ISO-8601 timestamp after which the task should no longer run

If a `task.cancel` arrives before the ACP agent returns a final answer, the bridge suppresses any later result send for that task.

While ACP execution is in progress, the bridge can:

- create an AAMP task stream for the task
- send `task.stream.opened`
- append `status`, `progress`, and `text.delta` events
- close the stream before the authoritative `task.result` or `task.help_needed`

## Config

Minimal example:

```json
{
  "aampHost": "https://meshmail.ai",
  "rejectUnauthorized": false,
  "agents": [
    {
      "name": "claude",
      "acpCommand": "claude",
      "slug": "claude-bridge",
      "credentialsFile": "~/.acp-bridge/.aamp-claude.json",
      "senderWhitelist": [
        "system@aamp.local"
      ]
    }
  ]
}
```

`senderWhitelist` is optional. If configured, the bridge only accepts tasks from those email addresses.
`credentialsFile` is optional. If omitted, the bridge uses `~/.acp-bridge/.aamp-<agent>.json`.
