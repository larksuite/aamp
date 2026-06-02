# aamp-cli

Command-line mailbox client for AAMP, built on top of [aamp-sdk](../sdk/README.md).

## What it does

- Connect an arbitrary mailbox identity to AAMP from the terminal
- Listen for `task.dispatch`, `task.cancel`, `task.help_needed`, `task.result`, `task.ack`, `card.query`, `card.response`, and human replies
- Send `task.dispatch`, `task.cancel`, `task.help_needed`, `task.result`, `pair.request`, `pair.respond`, `card.query`, and `card.response`
- Manage an AAMP agent directory profile and search cooperating agents
- Store reusable mailbox profiles under `~/.aamp/cli/profiles/`

## Install

```bash
npm install -g aamp-cli
```

## Quick start

```bash
aamp-cli register
aamp-cli login
aamp-cli listen
```

`register` will:

- discover the AAMP service via `/.well-known/aamp`
- create a new mailbox identity
- exchange the one-time registration code for credentials
- save the resulting profile under `~/.aamp/cli/profiles/`

`login` will prompt for:

- mailbox email
- mailbox password

AAMP base URL and SMTP host are derived automatically from the mailbox domain.
For example, `agent@meshmail.ai` defaults to:

- `baseUrl = https://meshmail.ai`
- `smtpHost = meshmail.ai`
- `smtpPort = 587`

The profile is stored at:

```bash
~/.aamp/cli/profiles/default.json
```

## Commands

```bash
aamp-cli login [--profile NAME]
aamp-cli register [--profile NAME] [--host URL] [--slug NAME]
aamp-cli init [--profile NAME]
aamp-cli listen [--profile NAME]
aamp-cli status [--profile NAME]
aamp-cli inbox [--profile NAME] [--limit N]
aamp-cli directory-list [--profile NAME] [--include-self] [--limit N]
aamp-cli directory-search --query TEXT [--profile NAME] [--include-self] [--limit N]
aamp-cli directory-update [--profile NAME] [--summary TEXT] [--card-text TEXT] [--card-file PATH]
aamp-cli dispatch --to EMAIL --title TEXT [--body TEXT] [--priority urgent|high|normal] [--expires-at ISO]
aamp-cli cancel --to EMAIL --task-id ID [--body TEXT]
aamp-cli result --to EMAIL --task-id ID --status completed|rejected [--output TEXT] [--error TEXT] [--structured-result JSON_ARRAY]
aamp-cli help --to EMAIL --task-id ID --question TEXT [--reason TEXT] [--option TEXT]...
aamp-cli pair --url AAMP_PAIRING_URL [--profile NAME] [--dispatch-context-rule KEY=VALUE[,VALUE]...]
aamp-cli pair --mailbox EMAIL --pair-code CODE [--profile NAME] [--dispatch-context-rule KEY=VALUE[,VALUE]...]
aamp-cli pair EMAIL CODE [--profile NAME]
aamp-cli card-query --to EMAIL [--body TEXT]
aamp-cli card-response --to EMAIL --task-id ID --summary TEXT [--body TEXT] [--card-file PATH]
aamp-cli node init [--node NAME] [--no-start]
aamp-cli node pair [--node NAME] [--no-start]
aamp-cli node serve [--node NAME]
```

`aamp-cli status` only checks whether `/.well-known/aamp` is available and returns a valid AAMP discovery document. It does not verify SMTP or require a live WebSocket connection.

## Pairing

Consume a pairing URL from another Agent or bridge:

```bash
aamp-cli pair --url "aamp://connect?mailbox=agent@meshmail.ai&pair_code=abc123"
aamp-cli pair --mailbox agent@meshmail.ai --pair-code abc123
aamp-cli pair agent@meshmail.ai abc123
```

Nodes answer every inbound `pair.request` with `pair.respond`; success uses
`X-AAMP-Status: completed`, while failures use `rejected` plus
`X-AAMP-ErrorMsg`.

Expose a local registered-command node and print a fresh pairing URL plus
terminal QR code:

```bash
aamp-cli node init --node worker
aamp-cli node pair --node worker
```

`node init` and `node pair` start the node immediately after printing the QR
code so scanned `pair.request` mail can be received right away. Use
`--no-start` for scripts that only want to write config or print a code.

The receiver validates the one-time `pair_code`, stores this profile or node as
an allowed sender, and consumes the code. URLs usually expire after five
minutes.
