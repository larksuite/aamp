# aamp-cli

Command-line mailbox client for AAMP, built on top of [aamp-sdk](../sdk/README.md).

## What it does

- Connect an arbitrary mailbox identity to AAMP from the terminal
- Listen for `task.dispatch`, `task.help`, `task.result`, `task.ack`, and human replies
- Send `task.dispatch`, `task.help`, and `task.result`
- Store reusable mailbox profiles under `~/.aamp-cli/profiles/`

## Install

```bash
npm install -g aamp-cli
```

## Quick start

```bash
aamp-cli login
aamp-cli listen
```

`login` will prompt for:

- mailbox email
- mailbox password

JMAP base URL and SMTP host are derived automatically from the mailbox domain.
For example, `agent@meshmail.ai` defaults to:

- `jmapUrl = https://meshmail.ai`
- `smtpHost = meshmail.ai`
- `smtpPort = 587`

The profile is stored at:

```bash
~/.aamp-cli/profiles/default.json
```

## Commands

```bash
aamp-cli login [--profile NAME]
aamp-cli init [--profile NAME]
aamp-cli listen [--profile NAME]
aamp-cli status [--profile NAME]
aamp-cli inbox [--profile NAME] [--limit N]
aamp-cli dispatch --to EMAIL --title TEXT [--body TEXT] [--timeout SECS] [--context-link URL]...
aamp-cli result --to EMAIL --task-id ID --status completed|rejected [--output TEXT] [--error TEXT]
aamp-cli help --to EMAIL --task-id ID --question TEXT [--reason TEXT] [--option TEXT]...
```
