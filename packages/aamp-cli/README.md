# aamp-cli

Command-line mailbox client for AAMP, built on top of [aamp-sdk](../sdks/nodejs/README.md).

## What it does

- Connect an arbitrary mailbox identity to AAMP from the terminal
- Listen for `task.dispatch`, `task.cancel`, `task.help_needed`, `task.result`, `task.ack`, `card.query`, `card.response`, and human replies
- Send `task.dispatch`, `task.cancel`, `task.help_needed`, `task.result`, `card.query`, and `card.response`
- Manage an AAMP agent directory profile and search cooperating agents
- Run a local registered-command node with `aamp-cli node serve`
- Call a remote registered-command node with `aamp-cli node call`
- Store reusable mailbox profiles under `~/.aamp-cli/profiles/`

## Install

```bash
npm install -g aamp-cli
```

## Quick start

```bash
aamp-cli register
aamp-cli login
aamp-cli listen
aamp-cli node init
aamp-cli node serve
```

`register` will:

- discover the AAMP service via `/.well-known/aamp`
- create a new mailbox identity
- exchange the one-time registration code for credentials
- save the resulting profile under `~/.aamp-cli/profiles/`

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
~/.aamp-cli/profiles/default.json
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
aamp-cli dispatch --to EMAIL --title TEXT [--body TEXT] [--priority urgent|high|normal] [--expires-at ISO] [--context-link URL]...
aamp-cli cancel --to EMAIL --task-id ID [--body TEXT]
aamp-cli result --to EMAIL --task-id ID --status completed|rejected [--output TEXT] [--error TEXT]
aamp-cli help --to EMAIL --task-id ID --question TEXT [--reason TEXT] [--option TEXT]...
aamp-cli card-query --to EMAIL [--body TEXT]
aamp-cli card-response --to EMAIL --task-id ID --summary TEXT [--body TEXT] [--card-file PATH]
aamp-cli node <init|show|serve|sync-card|call|command|policy> ...
```

## Registered command nodes

`aamp-cli node serve` turns the local machine into a constrained AAMP execution
node. It does not allow arbitrary shell execution. Instead, you register a
small set of commands and declare their argument schema, working directory, and
optional attachment slots.

Typical flow:

```bash
aamp-cli node init
aamp-cli node command add
aamp-cli node policy set --default-action deny --allow-from caller@meshmail.ai --allow-command update_bundle
aamp-cli node serve
```

To call one of these nodes from another machine or mailbox profile:

```bash
aamp-cli node call \
  --target worker@meshmail.ai \
  --command update_bundle \
  --stream full \
  --artifact_bundle /path/to/bundle.tar.gz
```

The CLI automatically builds a valid `registered-command/v1` dispatch body and
attaches any referenced local files.
