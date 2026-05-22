# aamp-acp-bridge

Config-driven bridge that connects ACP-compatible agents to the AAMP email network.

## Install

```bash
npm install aamp-acp-bridge
```

## Usage

Initialize the bridge:

```bash
npx aamp-acp-bridge init
```

The init wizard scans installed ACP-capable agents, then lets you select multiple entries with arrow keys, Space, and Enter. For each selected agent, choose one authorization setup method:

- Pair with a five-minute terminal QR code plus the matching `aamp://connect?...` URL.
- Manually enter `senderPolicies`.
- Reuse existing `senderPolicies`, when any are available.
- Configure sender authorization later; `task.dispatch` is rejected until pairing or policy setup is complete.

If you choose QR pairing, `init` starts the bridge immediately after writing config, so scanning the QR code with AAMP App works right away. The bridge answers each `pair.request` with `pair.respond`; rejected responses include the failure reason.

Use `--no-start` only when you need to generate config in a script without
keeping the bridge process running:

```bash
npx aamp-acp-bridge init --agent claude --no-start
```

After an agent has been initialized, generate a fresh pairing QR code without
re-running setup:

```bash
npx aamp-acp-bridge pair --agent claude
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

`senderPolicies` is optional, but omitted policies do not authorize anyone by default. Use QR pairing or configure at least one policy before sending `task.dispatch`; matching policies can also enforce exact-match `X-AAMP-Dispatch-Context` rules.
Legacy `senderWhitelist` configs still load and are normalized into `senderPolicies`.
When editing the `senderPoliciesFile` directly, `pairedAt` is optional; the bridge accepts manually added records with just `sender` and optional `dispatchContextRules`.
`credentialsFile` is optional. If omitted, the bridge uses `~/.aamp/acp-bridge/credentials/<agent>.json`.
`taskDispatchConcurrency` is optional and defaults to `10`.
