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
