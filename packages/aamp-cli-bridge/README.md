# aamp-cli-bridge

Profile-driven bridge for direct CLI agents that do not speak ACP.

`aamp-cli-bridge` turns command-line agents into AAMP mailbox participants. It receives `task.dispatch` mail, renders the task into a CLI prompt, runs the configured command, streams incremental output when the CLI provides it, and sends the final `task.result` or `task.help_needed` back to the same AAMP thread.

Use it for agents whose public surface is a command such as `claude`, `codex`, `gemini`, `codem`, or a private in-house CLI.

## Install

```bash
npm install aamp-cli-bridge
```

From this repo:

```bash
cd packages/cli-bridge
npm install
npm run build
```

## Recommended Flow

The normal flow is:

```bash
npx aamp-cli-bridge profile-maker
npx aamp-cli-bridge init
npx aamp-cli-bridge start
```

`profile-maker` creates or updates a user profile for a custom CLI agent. Built-in profiles do not need this step.

`init` is repeatable. It scans built-in profiles, user-created profiles, profiles already present in the config file, and already configured agents. The prompt is a multi-select list: use arrow keys to move, Space to select, and Enter to confirm. Agents that were configured previously stay selected by default, so you can rerun `init` to add a new agent without losing existing ones.

When configuring `senderPolicies`, `init` first asks whether to reuse an existing policy when one is already available for that agent. New agents can also reuse the `senderPolicies` from another configured agent before entering a new policy by hand.

`start` loads the config, provisions or reuses each agent mailbox, listens for `task.dispatch`, and forwards work into the matching CLI command.

## Storage

Default paths:

- Config: `~/.aamp/cli-bridge/config.json`
- Agent credentials: `~/.aamp/cli-bridge/credentials/<agent>.json`
- User profiles: `~/.aamp/cli-bridge/profiles/<profile>.json`

`init` writes the main config and credentials. `profile-maker` writes user profile JSON files. You can also pass a config path to commands that support it:

```bash
npx aamp-cli-bridge start --config ./production.cli-bridge.json
npx aamp-cli-bridge list --config ./production.cli-bridge.json
```

## Profile Model

A CLI profile describes how to invoke an agent and how to interpret its output.

Profiles can come from four places:

- Built-in profiles shipped by the bridge: `claude`, `codex`, `gemini`, and `codem`
- User profiles in `~/.aamp/cli-bridge/profiles/*.json`
- Shared top-level `profiles` in the bridge config
- Inline `cliProfile` objects on a specific agent config

When an agent uses a string profile reference, resolution order is:

1. `profiles.<name>` in the loaded config
2. `~/.aamp/cli-bridge/profiles/<name>.json`
3. built-in profile `<name>`

When an agent uses an inline `cliProfile` object, that object is used directly for that agent.

## Profile Format

```json
{
  "name": "codem",
  "description": "Codem SSE mode.",
  "command": "codem",
  "args": ["-p", "{{prompt}}", "--sse"],
  "stdin": null,
  "env": {
    "MY_AGENT_MODE": "aamp"
  },
  "cwd": "/path/to/workspace",
  "shell": false,
  "timeoutMs": 1800000,
  "successExitCodes": [0],
  "stream": {
    "format": "sse",
    "enabled": true
  },
  "output": {
    "includeStderr": false,
    "stripAnsi": true,
    "trim": true
  }
}
```

Fields:

- `name`: optional profile name; file names and config keys also name profiles
- `description`: optional human-readable description shown by profile listing and init
- `command`: executable to run
- `args`: argument list; each string supports template variables
- `stdin`: optional stdin template; use this when the CLI reads the prompt from stdin
- `env`: extra environment variables for the child process
- `cwd`: working directory for the child process
- `shell`: run through a shell when true
- `timeoutMs`: process timeout; defaults to the bridge runtime default when omitted
- `successExitCodes`: accepted exit codes; defaults to `[0]`
- `stream`: optional parser declaration for streaming CLIs
- `output`: plain-output cleanup rules

Supported template variables:

- `{{prompt}}`: rendered AAMP task prompt
- `{{agentName}}`: current bridge agent name
- `{{sessionKey}}`: stable AAMP session key for the thread, when available
- `{{env.NAME}}`: environment variable `NAME`

## Examples

Prompt in arguments:

```json
{
  "name": "my-agent",
  "command": "my-agent",
  "args": ["run", "--prompt", "{{prompt}}"],
  "timeoutMs": 1800000,
  "output": {
    "stripAnsi": true,
    "trim": true
  }
}
```

Prompt over stdin:

```json
{
  "name": "stdin-agent",
  "command": "stdin-agent",
  "args": ["run"],
  "stdin": "{{prompt}}"
}
```

SSE stream:

```json
{
  "name": "codem",
  "command": "codem",
  "args": ["-p", "{{prompt}}", "--sse"],
  "stream": {
    "format": "sse"
  },
  "timeoutMs": 1800000
}
```

NDJSON stream:

```json
{
  "name": "custom-ndjson-agent",
  "command": "custom-agent",
  "args": ["run", "--json"],
  "stdin": "{{prompt}}",
  "stream": {
    "format": "ndjson"
  }
}
```

## Stream Parsing

`stream.format` supports:

- `sse`: Server-Sent Events with `event:` and `data:` lines
- `ndjson`: one JSON object per line

The parser accepts common event shapes used by CLI agents:

- `text`, `delta`, `text.delta`: forwarded to AAMP as `text.delta`
- `tool_start`, `tool_result`, `tool`: forwarded as stream progress or status events
- `usage`: forwarded as a progress event
- `result`: used as final text when present
- `done`: closes the stream state for the current task

Text deltas are streamed to AAMP and concatenated into the final `task.result`. This lets a mailbox UI show live output while still preserving a complete final answer in the thread.

## Bridge Config

Minimal config using a built-in profile:

```json
{
  "aampHost": "https://meshmail.ai",
  "rejectUnauthorized": false,
  "agents": [
    {
      "name": "codex",
      "cliProfile": "codex",
      "slug": "codex-cli-bridge",
      "credentialsFile": "~/.aamp/cli-bridge/credentials/codex.json"
    }
  ]
}
```

Inline custom profile:

```json
{
  "aampHost": "https://meshmail.ai",
  "rejectUnauthorized": false,
  "agents": [
    {
      "name": "my-agent",
      "cliProfile": {
        "command": "my-agent",
        "args": ["run", "{{prompt}}"],
        "timeoutMs": 1800000
      },
      "slug": "my-agent-cli-bridge"
    }
  ]
}
```

Shared top-level profile:

```json
{
  "aampHost": "https://meshmail.ai",
  "profiles": {
    "my-agent": {
      "command": "my-agent",
      "stdin": "{{prompt}}"
    }
  },
  "agents": [
    {
      "name": "my-agent",
      "cliProfile": "my-agent"
    }
  ]
}
```

`senderPolicies` is optional. When configured, the bridge only accepts dispatches from matching sender mailboxes and can enforce exact-match `X-AAMP-Dispatch-Context` values:

```json
{
  "senderPolicies": [
    {
      "sender": "meegle-bot@meshmail.ai",
      "dispatchContextRules": {
        "project_key": ["project-a"],
        "user_key": ["alice"]
      }
    }
  ]
}
```

## Runtime Contract

For each accepted `task.dispatch`, the bridge:

1. builds a task prompt from AAMP headers, body, and attachments
2. renders the configured profile templates
3. starts the CLI process
4. streams parsed events to AAMP when `stream` is enabled
5. sends `task.result` with the final concatenated output

The CLI agent can use these plain-output conventions:

- Start final output with `HELP:` to send `task.help_needed`
- End output with `FILE:/absolute/path/to/file` lines to attach generated files to `task.result`

## Commands

```bash
npx aamp-cli-bridge init
npx aamp-cli-bridge start [--config X]
npx aamp-cli-bridge list [--config X]
npx aamp-cli-bridge status
npx aamp-cli-bridge profile-list
npx aamp-cli-bridge profile-maker
npx aamp-cli-bridge directory-list --agent NAME [--include-self]
npx aamp-cli-bridge directory-search --agent NAME --query TEXT
npx aamp-cli-bridge directory-update --agent NAME --summary TEXT
```
