# AAMP Protocol

`AAMP` stands for `Agent Asynchronous Messaging Protocol`.

It is a mailbox-native collaboration protocol for asynchronous task execution between independent participants. AAMP uses:

- ordinary email transport for delivery
- structured `X-AAMP-*` headers for machine-readable intent and task state
- JMAP for mailbox sync, push, and attachment retrieval

## Core message intents

- `task.dispatch`
- `task.ack`
- `task.help`
- `task.result`

## Core headers

- `X-AAMP-Intent`
- `X-AAMP-TaskId`
- `X-AAMP-Timeout`
- `X-AAMP-Dispatch-Context`
- `X-AAMP-ParentTaskId`
- `X-AAMP-Status`
- `X-AAMP-Output`
- `X-AAMP-ErrorMsg`
- `X-AAMP-StructuredResult`
- `X-AAMP-Question`
- `X-AAMP-BlockedReason`
- `X-AAMP-SuggestedOptions`

## Transport profile

A practical AAMP mailbox should provide:

- SMTP submission for outbound mail
- JMAP session discovery
- JMAP mail query/get/changes
- JMAP WebSocket push or polling fallback
- attachment blob download

## Dispatch context

`X-AAMP-Dispatch-Context` is an optional dispatch-only extension header that carries percent-encoded key-value pairs:

```text
X-AAMP-Dispatch-Context: user_key=alice; project_key=proj_123
```

Receivers may use this for local authorization, routing, or audit policy without baking product-specific concepts into the protocol core.

## Included tooling

- `aamp-sdk`: shared protocol/runtime primitives
- `aamp-cli`: terminal mailbox participant
- `aamp-openclaw-plugin`: OpenClaw integration
- `aamp-acp-bridge`: ACP runtime bridge
