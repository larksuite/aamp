# aamp-feishu-bridge

Local bridge daemon that connects a user-owned Feishu bot to a target AAMP agent.

## Install

```bash
npm install aamp-feishu-bridge
```

## Usage

Initialize local bridge config and mailbox identity:

```bash
npx aamp-feishu-bridge init
```

Run the daemon:

```bash
npx aamp-feishu-bridge run
```

Inspect current config and runtime state:

```bash
npx aamp-feishu-bridge status
```

By default, bridge config and runtime state are stored under `~/.aamp/feishu-bridge/`.

## What it does

The bridge is designed for users who want to keep Feishu bot credentials on their own machine rather than in a hosted bridge service.

It can:

- receive Feishu direct messages
- receive group messages where the bot is explicitly mentioned
- provision or reuse an AAMP mailbox identity for the bridge
- dispatch each chat turn as a fresh `task.dispatch`
- preserve sticky conversation state through `X-AAMP-Dispatch-Context.session_key`
- stream `task.stream.opened` and `text.delta` back into Feishu through CardKit
- translate `task.help_needed` into a follow-up card and send the reply back to the same AAMP thread

## Dispatch context

Each dispatch sent by the bridge includes Feishu-specific routing metadata in `X-AAMP-Dispatch-Context`, including:

- `source=feishu`
- `sender_open_id`
- `sender_name`
- `chat_id`
- `chat_type`
- `session_key`
- `thread_key`

The key design rule is:

- each user message becomes a new `task.dispatch`
- session continuity is expressed through `session_key`, not by reusing the same `taskId`

Runtimes such as `aamp-openclaw-plugin` and `aamp-acp-bridge` can use that session key to keep multiple turns inside the same underlying agent session.

## Feishu permissions

You will typically need these Feishu permissions for the bot application:

- `im:message.p2p_msg:readonly`
- `im:message.group_at_msg:readonly`
- `im:message:send_as_bot`
- `im:message:update`
- `cardkit:card:read`
- `cardkit:card:write`
- `im:chat:read`
- `im:chat.members:read`
- `contact:user.base:readonly`

Use the Feishu event WebSocket mode and subscribe to `im.message.receive_v1`.
