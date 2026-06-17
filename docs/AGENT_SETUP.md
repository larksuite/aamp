# Agent-Friendly AAMP Setup

This document is written for an AI coding agent. If a user gives you this
document and asks you to connect Codex, Claude, OpenClaw, or another local
agent to AAMP, execute the steps below and finish by reporting the agent
mailbox plus the pairing code or pairing URL.

Default AAMP host:

```bash
export AAMP_HOST="${AAMP_HOST:-https://meshmail.ai}"
```

## Goal

For each requested local agent:

1. Choose the right AAMP connector.
2. Install the connector with `npx -y`.
3. Register or reuse an AAMP mailbox.
4. Configure sender authorization by either writing `senderPolicies` or
   creating a short-lived pairing URL.
5. Start the bridge and verify it stays running. Without a live bridge, the
   mailbox exists but the agent cannot consume `pair.request` or
   `task.dispatch`.
6. Return:
   - agent name
   - connector type
   - AAMP mailbox email
   - pairing code and `aamp://connect?...` URL, if pairing was created
   - runtime status, normally `running`
   - whether Meego, Base, or GitHub senders were approved, if applicable

Do not print SMTP passwords, mailbox tokens, credential JSON contents, web
pairing URLs, log paths, process IDs, or start/stop commands in the final
response unless the user explicitly asks for runtime operation details.

## Connector Choice

Use this order:

| Requested agent | Preferred connector | Fallback |
| --- | --- | --- |
| `codex` | `aamp-acp-bridge` | `aamp-cli-bridge` with built-in `codex` profile |
| `claude` | `aamp-acp-bridge` | `aamp-cli-bridge` with built-in `claude` profile |
| `openclaw` | `aamp-openclaw-plugin` | `aamp-acp-bridge`, then `aamp-cli-bridge` |
| known ACP-compatible agent | `aamp-acp-bridge` | `aamp-cli-bridge` |
| custom ACP-compatible agent | `aamp-acp-bridge` with explicit `acpCommand` | `aamp-cli-bridge` |
| CLI-callable agent | `aamp-cli-bridge` with a built-in or custom profile | ask for the command/profile details |

Prefer `aamp-acp-bridge` for Codex and Claude because it preserves richer ACP
task events. Use `aamp-cli-bridge` when the agent is only available as a direct
CLI command, or when the installed/published ACP bridge does not expose the
JSON automation commands used below.

Known ACP agent names:

| Agent name | ACP command used by bridge |
| --- | --- |
| `claude` | `claude` |
| `codex` | Codex via `@agentclientprotocol/codex-acp` |
| `gemini` | `gemini` |
| `goose` | `goose` |
| `openclaw` | `openclaw` |
| `opencode` | `opencode` |
| `cursor` | `cursor` |
| `copilot` | `copilot` |
| `kimi` | `kimi` |
| `kiro` | `kiro` |
| `hermes` | `hermes acp` |

If one of these is requested and installed, configure it with ACP Bridge unless
the table above says a more native connector is preferred, as with OpenClaw.
If a different agent can speak ACP, still use ACP Bridge, but provide its
explicit `acpCommand`.

Built-in CLI Bridge profiles:

| Profile | Command shape |
| --- | --- |
| `claude` | `claude -p "{{prompt}}" --resume "{{sessionKey}}"` |
| `codex` | `codex exec --session-id "{{sessionKey}}" --skip-git-repo-check "{{prompt}}"` |
| `coco` | `coco -p "{{prompt}}" --yolo --resume "{{sessionKey}}"` |
| `gemini` | `gemini --prompt "{{prompt}}" --resume "{{sessionKey}}"` |
| `codem` | `codem -p "{{prompt}}" --sse --yolo --session "{{safeSessionKey}}"` |

If a CLI-callable agent is not in this built-in list, create a custom CLI
profile before initializing CLI Bridge.

## Discover Local Agents

Run both discovery commands when possible. They are safe and do not create
mailboxes.

```bash
npx -y aamp-acp-bridge discover --json
npx -y aamp-cli-bridge discover --json
```

The ACP bridge must return JSON for `discover --json`, and its help output must
list both `discover` and `init --json --input -`:

```bash
npx -y aamp-acp-bridge help
```

If `aamp-acp-bridge discover --json` prints a help screen, exits without JSON,
or `help` does not mention `discover`, treat that ACP bridge executable as too
old for non-interactive setup. Do not pipe JSON into its interactive `init`
wizard. For Codex or Claude, use the CLI Bridge fallback instead.

Select the requested agents from the discovery output. If the user requested
multiple agents, configure each one independently.

## ACP Bridge For Known Agents

Use this non-interactive flow for any known ACP agent when the ACP bridge can
discover the agent and supports the JSON automation commands above.

Replace `codex` with the requested known ACP agent name.

```bash
printf '%s\n' '{
  "aampHost": "'"${AAMP_HOST:-https://meshmail.ai}"'",
  "agents": [
    {
      "name": "codex",
      "createPairing": true
    }
  ]
}' | npx -y aamp-acp-bridge init --json --input -
```

Read the JSON output. The important fields are:

- `agents[0].email`
- `agents[0].pairing.pairCode`
- `agents[0].pairing.connectUrl`
- `agents[0].credentialsFile`

Generate a fresh pairing code later:

```bash
npx -y aamp-acp-bridge pair --agent codex --json --no-start
```

## ACP Bridge For Custom ACP Agents

If the requested agent is not in the known ACP list but the user or local docs
show that it exposes an ACP command, configure ACP Bridge with an explicit
`acpCommand`.

Use a short lowercase name for `name` and `slug`. Replace `my-agent-acp serve`
with the real ACP command.

```bash
printf '%s\n' '{
  "aampHost": "'"${AAMP_HOST:-https://meshmail.ai}"'",
  "agents": [
    {
      "name": "my-agent",
      "acpCommand": "my-agent-acp serve",
      "slug": "my-agent-bridge",
      "createPairing": true
    }
  ]
}' | npx -y aamp-acp-bridge init --json --input -
```

If this fails because the command is not ACP-compatible, fall back to CLI Bridge
and create a CLI profile.

## CLI Bridge For Built-In Profiles

Use this when ACP discovery fails but the direct CLI command is available, or
when the requested agent is a CLI-only agent with a built-in profile.

Replace `codex` with any built-in CLI Bridge profile name:
`claude`, `codex`, `coco`, `gemini`, or `codem`.

```bash
printf '%s\n' '{
  "aampHost": "'"${AAMP_HOST:-https://meshmail.ai}"'",
  "agents": [
    {
      "name": "codex",
      "cliProfile": "codex",
      "createPairing": true
    }
  ]
}' | npx -y aamp-cli-bridge init --json --input -
```

Generate a fresh pairing code later:

```bash
npx -y aamp-cli-bridge pair --agent codex --json --no-start
```

Default CLI bridge files:

- config: `~/.aamp/cli-bridge/config.json`
- credentials: `~/.aamp/cli-bridge/credentials/<agent>.json`
- pairing: `~/.aamp/cli-bridge/pairing/<agent>.json`
- sender policies: `~/.aamp/cli-bridge/sender-policies/<agent>.json`

## CLI Bridge For Custom CLI Agents

Use this when the agent can be invoked from a terminal but does not expose ACP,
or when no built-in CLI profile matches it.

First inspect the command help and identify how the CLI accepts a prompt:

```bash
my-agent --help
my-agent --version
```

| CLI style | Profile pattern |
| --- | --- |
| prompt argument | put `{{prompt}}` in `args` |
| stdin prompt | set `stdin` to `{{prompt}}` |
| session/resume flag | pass `{{sessionKey}}` or `{{safeSessionKey}}` |
| SSE streaming | set `stream.format` to `sse` |
| NDJSON streaming | set `stream.format` to `ndjson` |

Create a custom profile under `~/.aamp/cli-bridge/profiles/<profile>.json`.
Use lowercase letters, digits, and hyphens for the profile name.
You may also use the interactive profile maker:

```bash
npx -y aamp-cli-bridge profile-maker
```

Prompt-as-argument example:

```bash
mkdir -p ~/.aamp/cli-bridge/profiles
cat > ~/.aamp/cli-bridge/profiles/my-agent.json <<'JSON'
{
  "description": "My Agent CLI profile.",
  "command": "my-agent",
  "args": ["run", "--prompt", "{{prompt}}", "--session", "{{sessionKey}}"],
  "timeoutMs": 1800000,
  "output": {
    "stripAnsi": true,
    "trim": true
  }
}
JSON
```

Prompt-over-stdin example:

```bash
mkdir -p ~/.aamp/cli-bridge/profiles
cat > ~/.aamp/cli-bridge/profiles/stdin-agent.json <<'JSON'
{
  "description": "Stdin Agent CLI profile.",
  "command": "stdin-agent",
  "args": ["run"],
  "stdin": "{{prompt}}",
  "timeoutMs": 1800000,
  "output": {
    "stripAnsi": true,
    "trim": true
  }
}
JSON
```

SSE streaming example:

```bash
mkdir -p ~/.aamp/cli-bridge/profiles
cat > ~/.aamp/cli-bridge/profiles/stream-agent.json <<'JSON'
{
  "description": "Streaming Agent CLI profile.",
  "command": "stream-agent",
  "args": ["run", "--prompt", "{{prompt}}", "--sse"],
  "timeoutMs": 1800000,
  "stream": {
    "format": "sse"
  },
  "output": {
    "stripAnsi": true,
    "trim": true
  }
}
JSON
```

NDJSON streaming example:

```bash
mkdir -p ~/.aamp/cli-bridge/profiles
cat > ~/.aamp/cli-bridge/profiles/ndjson-agent.json <<'JSON'
{
  "description": "NDJSON Agent CLI profile.",
  "command": "ndjson-agent",
  "args": ["run", "--json"],
  "stdin": "{{prompt}}",
  "timeoutMs": 1800000,
  "stream": {
    "format": "ndjson"
  },
  "output": {
    "stripAnsi": true,
    "trim": true
  }
}
JSON
```

Verify that CLI Bridge can see the profile:

```bash
npx -y aamp-cli-bridge profile-list
npx -y aamp-cli-bridge discover --json
```

Then initialize the custom agent. Replace `my-agent` with the profile name you
created.

```bash
printf '%s\n' '{
  "aampHost": "'"${AAMP_HOST:-https://meshmail.ai}"'",
  "agents": [
    {
      "name": "my-agent",
      "cliProfile": "my-agent",
      "createPairing": true
    }
  ]
}' | npx -y aamp-cli-bridge init --json --input -
```

If the CLI command requires environment variables or a working directory, add
`env` and `cwd` to the profile. If the command must run through a shell, set
`shell` to `true`, but prefer direct `command` plus `args` when possible.

## OpenClaw

If the requested agent is OpenClaw, prefer the native plugin:

```bash
npx -y aamp-openclaw-plugin init
```

The installer prompts for:

- AAMP host, usually `https://meshmail.ai`
- primary trusted sender, if the user already knows it
- optional dispatch context rules

When OpenClaw starts with the plugin enabled, it prints a five-minute
`aamp://connect?...` pairing URL and QR target. If OpenClaw is already running,
ask it to call the `aamp_pairing_code` tool or run `/aamp-pair`.

If the plugin cannot be installed and `openclaw` appears in ACP discovery,
configure it with ACP bridge:

```bash
printf '%s\n' '{
  "aampHost": "'"${AAMP_HOST:-https://meshmail.ai}"'",
  "agents": [
    {
      "name": "openclaw",
      "createPairing": true
    }
  ]
}' | npx -y aamp-acp-bridge init --json --input -
```

## Sender Policy

A receiver rejects `task.dispatch` unless the sender is authorized. Use one of
the flows below to complete this.

### Automatic Product Sender Policies

If the user says they want to use the agent from Meego, Base, or GitHub, add the
matching `senderPolicies` directly during initialization. Tell the user that all
requests from the named product are approved, and that they can provide more
details later if they want fine-grained controls.

| Product mentioned by user | Sender policies to add |
| --- | --- |
| Meego / Feishu Project | `meego@meshmail.ai`, `feishu-project@meshmail.ai` |
| Base / Lark Base | `lark-base@meshmail.ai` |
| GitHub | `github@meshmail.ai` |

For example, if the user says "connect Codex to AAMP so I can use it from Meego
and GitHub", initialize Codex with these senders:

```bash
printf '%s\n' '{
  "aampHost": "'"${AAMP_HOST:-https://meshmail.ai}"'",
  "agents": [
    {
      "name": "codex",
      "senderPolicies": [
        { "sender": "meego@meshmail.ai" },
        { "sender": "feishu-project@meshmail.ai" },
        { "sender": "github@meshmail.ai" }
      ],
      "createPairing": true
    }
  ]
}' | npx -y aamp-acp-bridge init --json --input -
```

Use the same `senderPolicies` array with `aamp-cli-bridge` if you selected CLI
Bridge instead of ACP Bridge.

### Pairing URL

When `createPairing: true` is used, the bridge creates a five-minute one-time
pairing code and URL:

```text
aamp://connect?mailbox=<agent-email>&pair_code=<code>
```

Give the URL to the user. They can paste it into AAMP User UI, scan it with the
AAMP App, or pair from another AAMP mailbox:

```bash
aamp-cli pair --url "aamp://connect?mailbox=<agent-email>&pair_code=<code>"
```

On success, the receiver writes the requesting mailbox into its sender policy
file and consumes the code.

### Manual: Write Sender Policies During Init

If the user gives you one or more dispatcher mailbox addresses, initialize with
`senderPolicies` instead of or in addition to `createPairing`.

ACP bridge example:

```bash
printf '%s\n' '{
  "aampHost": "'"${AAMP_HOST:-https://meshmail.ai}"'",
  "agents": [
    {
      "name": "codex",
      "senderPolicies": [
        {
          "sender": "dispatcher@meshmail.ai",
          "dispatchContextRules": {
            "project_key": ["proj_123"]
          }
        }
      ],
      "createPairing": true
    }
  ]
}' | npx -y aamp-acp-bridge init --json --input -
```

`dispatchContextRules` is optional. Use it only when the user provides exact
rules. Keys are matched against `X-AAMP-Dispatch-Context`; all configured keys
must match one of the allowed values.

## Verification

After setup, list configured agents:

```bash
npx -y aamp-acp-bridge list --json
npx -y aamp-cli-bridge list --json
```

Use the command matching the bridge you configured. Confirm that:

- the requested agent appears
- `email` is present
- config and credential files exist
- a pairing URL was created, or `senderPolicies` are present

## Runtime Operation

The setup task is not complete until the bridge is running. The mailbox and
pairing URL are only useful when the bridge process is alive to receive
`pair.request` and `task.dispatch`.

Prefer the user's existing process manager, AAMP desktop app, or agent hub when
one is already managing AAMP bridges. Otherwise use a deterministic detached
session. Do not improvise multiple background strategies unless the first
supported strategy fails.

Use `screen` when available:

ACP Bridge:

```bash
AGENT_NAME=codex
mkdir -p ~/.aamp/logs
screen -S "aamp-acp-${AGENT_NAME}" -X quit 2>/dev/null || true
screen -dmS "aamp-acp-${AGENT_NAME}" sh -lc "exec npx -y aamp-acp-bridge start --agent ${AGENT_NAME} --json >> ~/.aamp/logs/aamp-acp-${AGENT_NAME}.log 2>&1"
sleep 5
pgrep -fl "aamp-acp-bridge start --agent ${AGENT_NAME}"
```

CLI Bridge:

```bash
mkdir -p ~/.aamp/logs
screen -S "aamp-cli-bridge" -X quit 2>/dev/null || true
screen -dmS "aamp-cli-bridge" sh -lc "exec npx -y aamp-cli-bridge start --json >> ~/.aamp/logs/aamp-cli-bridge.log 2>&1"
sleep 5
pgrep -fl "aamp-cli-bridge start"
```

If `screen` is unavailable but `tmux` is available, use an equivalent detached
tmux session. If no detached process manager is available, start the bridge in
the foreground and clearly report that the runtime is not yet persistent after
the current terminal session exits.

Foreground commands for debugging:

```bash
npx -y aamp-acp-bridge start --agent codex --json
npx -y aamp-cli-bridge start --json
```

After the bridge is running, generate a fresh pairing code if the previous one
may expire soon.

## Final Response Template

End with a concise report like this:

```text
Connected Codex to AAMP.

Agent: codex
Connector: aamp-acp-bridge
Mailbox: codex-bridge-xxxx@meshmail.ai
Pairing code: abc123xyz
Pairing URL: aamp://connect?mailbox=codex-bridge-xxxx%40meshmail.ai&pair_code=abc123xyz
Runtime: running
[If applicable] Meego and GitHub access: approved all requests from Meego and GitHub.
```

If the user did not mention Meego, Base, or GitHub, add one sentence:

```text
If you want to use this agent from Meego, Base, or GitHub, tell me and I can add the related sender whitelist.
```

If the user did mention Meego, Base, or GitHub, add one sentence:

```text
I approved all requests from Meego / Base / GitHub. If you want finer control, tell me the project, repository, or context rules to enforce.
```

If setup fails, report the exact command that failed, the relevant error, and
the next best connector choice from the table above.
