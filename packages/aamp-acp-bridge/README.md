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
npx aamp-acp-bridge start
```

By default, the bridge stores its config under `~/.aamp/acp-bridge/config.json` and agent credentials under `~/.aamp/acp-bridge/credentials/`.
Legacy `./bridge.json` and `~/.acp-bridge/` data are migrated automatically on first use without deleting the original files.

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
- forward ACP `agent_thought_chunk` / `agent_message_chunk` updates into the AAMP stream in realtime
- expose tool progress as stream progress labels while the agent is working
- close the stream before the authoritative `task.result` or `task.help_needed`

When `acpx` supports `--format json --json-strict`, the bridge consumes the structured ACP NDJSON stream so reasoning / reply chunks can be forwarded live. Older `acpx` builds automatically fall back to plain-text mode, which preserves compatibility but cannot expose thought chunks incrementally.

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
      "taskDispatchConcurrency": 10,
      "credentialsFile": "~/.aamp/acp-bridge/credentials/claude.json",
      "senderPolicies": [
        {
          "sender": "system@aamp.local",
          "dispatchContextRules": {
            "project_key": ["proj_123"]
          }
        }
      ]
    }
  ]
}
```

`senderPolicies` is optional. If configured, the bridge requires the sender to match one policy and optionally enforces exact-match `X-AAMP-Dispatch-Context` rules.
Legacy `senderWhitelist` configs still load and are normalized into `senderPolicies`.
`credentialsFile` is optional. If omitted, the bridge uses `~/.aamp/acp-bridge/credentials/<agent>.json`.
`taskDispatchConcurrency` is optional and defaults to `10`.
