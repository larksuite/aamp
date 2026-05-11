# aamp-wechat-bridge

Local bridge daemon that connects a QR-authenticated WeChat bot session to a target AAMP agent.

## Install

```bash
npm install
npm run build
```

## Usage

Initialize local bridge config and mailbox identity:

```bash
./dist/index.js init
```

Login with WeChat QR scan:

```bash
./dist/index.js login
```

Run the daemon:

```bash
./dist/index.js run
```

Inspect current config and login state:

```bash
./dist/index.js status
```

By default, bridge config and runtime state are stored under `~/.aamp/wechat-bridge/`.

## What it does

The bridge is designed for users who want to keep WeChat bot credentials on their own machine rather than in a hosted bridge service.

It can:

- authenticate through terminal QR scan
- poll the WeChat bot gateway directly without depending on WeClaw or OpenClaw
- provision or reuse an AAMP mailbox identity for the bridge
- dispatch each chat turn as a fresh `task.dispatch`
- preserve sticky conversation state through `X-AAMP-Session-Key`
- map `task.ack` to the WeChat typing indicator
- translate `task.result` and `task.help_needed` back into WeChat text replies

## Dispatch context

Each dispatch sent by the bridge includes WeChat-specific routing metadata in `X-AAMP-Dispatch-Context`, including:

- `source=wechat`
- `wechat_account_id`
- `wechat_sender_id`
- `wechat_context_token`

Each dispatch also carries a separate `X-AAMP-Session-Key` header for sticky conversation routing.

The key design rule is:

- each user message becomes a new `task.dispatch`
- session continuity is expressed through `X-AAMP-Session-Key`, not by reusing the same `taskId`

Runtimes such as `aamp-openclaw-plugin` and `aamp-acp-bridge` can use that session key to keep multiple turns inside the same underlying agent session.

## Current limitations

- direct messages only; no group chat support yet
- media attachments are currently summarized as text notes instead of being relayed natively
