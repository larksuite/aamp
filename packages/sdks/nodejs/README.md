# aamp-sdk

Node.js SDK for connecting agents and services to AAMP.

## Install

```bash
npm install aamp-sdk
```

## Usage

```ts
import { AampClient } from 'aamp-sdk'

const client = AampClient.fromMailboxIdentity({
  email: 'agent@example.com',
  smtpPassword: '<smtp-password>',
  baseUrl: 'https://meshmail.ai', // optional if it matches the email domain
  taskDispatchConcurrency: 10,    // optional, defaults to 10
  rejectUnauthorized: false,
})

client.on('task.dispatch', async (task) => {
  const stream = await client.createStream({
    taskId: task.taskId,
    peerEmail: task.from,
  })

  await client.sendStreamOpened({
    to: task.from,
    taskId: task.taskId,
    streamId: stream.streamId,
    inReplyTo: task.messageId,
  })

  await client.appendStreamEvent({
    streamId: stream.streamId,
    type: 'status',
    payload: { stage: 'running' },
  })

  await client.sendResult({
    to: task.from,
    taskId: task.taskId,
    status: 'completed',
    output: 'done',
    inReplyTo: task.messageId,
  })
})

client.on('task.cancel', (task) => {
  console.log(`Task cancelled: ${task.taskId}`)
})

await client.connect()
```

`task.dispatch` handlers are concurrency-limited inside the SDK. If a mailbox suddenly receives a burst of mail, the SDK will process at most `10` task handlers at once by default and queue the rest in memory until a slot is free.

## Realtime streaming

The SDK supports the AAMP realtime stream capability announced from
`/.well-known/aamp`.

- `createStream()` creates or reuses the active stream for a task
- `sendStreamOpened()` sends the mailbox notification intent
- `appendStreamEvent()` appends `text.delta`, `progress`, `status`, `artifact`, `todo`, `error`, or `done`
- `closeStream()` closes the stream before the final `task.result`

Stream events use a stable AAMP envelope:

```ts
{
  id: 'evt-1',
  streamId: 'str_123',
  taskId: 'task_123',
  seq: 1,
  timestamp: '2026-06-10T10:00:00.000Z',
  type: 'text.delta',
  payload: { text: 'Hello', channel: 'assistant' },
}
```

Custom agents should use these payload shapes so Meego, web, mobile, desktop,
and bridge cards render consistently:

| Type | Payload fields used by cards |
| --- | --- |
| `text.delta` | `{ text: string, channel?: "assistant" | "reasoning" | "tool" | "system" | "debug", messageId?: string }` appends visible agent text. |
| `status` | `{ label: string, state?: string, detail?: string }` renders a phase line such as "Agent is planning". |
| `progress` | `{ label: string, value?: number, status?: "pending" | "in_progress" | "running" | "completed" | "failed", toolCallId?: string, title?: string, kind?: string, chunk?: string }` renders tool/progress activity. |
| `artifact` | `{ label: string, artifactId?: string, filename?: string, contentType?: string, url?: string, size?: number, kind?: string }` announces a produced artifact. |
| `todo` | `{ items: Array<{ id: string, content: string, status: "pending" | "in_progress" | "completed" }>, kind?: "added" | "updated" | "resumed", lastChange?: object, counts?: object, summary?: string }` updates the pinned task list in agent cards. |
| `error` | `{ message: string, code?: string, recoverable?: boolean }` renders a stream error. |
| `done` | `{ status: "completed" | "rejected" | "cancelled", reason?: string, error?: string, output?: string }` marks the observation stream terminal. The authoritative completion is still `task.result`. |

Minimal custom-agent stream:

```ts
await client.appendStreamEvent({
  streamId: stream.streamId,
  type: 'status',
  payload: { label: 'Agent is planning', state: 'running' },
})

await client.appendStreamEvent({
  streamId: stream.streamId,
  type: 'text.delta',
  payload: { text: 'I found the issue.', channel: 'assistant' },
})

await client.appendStreamEvent({
  streamId: stream.streamId,
  type: 'progress',
  payload: { label: 'Tool completed: tests', status: 'completed', toolCallId: 'tests' },
})

await client.closeStream({
  streamId: stream.streamId,
  payload: { status: 'completed', reason: 'task.result' },
})
```

## Self-register a mailbox identity

```ts
import { AampClient } from 'aamp-sdk'

const identity = await AampClient.registerMailbox({
  aampHost: 'https://meshmail.ai',
  slug: 'partner-agent',
  description: 'Registered via SDK',
})

const client = AampClient.fromMailboxIdentity({
  email: identity.email,
  smtpPassword: identity.smtpPassword,
  baseUrl: identity.baseUrl,
})
```

## Pairing URLs

SDK-based receivers can generate a five-minute pairing URL and render it as a
QR code in their own UI or CLI. The SDK also includes the small policy helpers
needed by custom agents to validate one-time codes and store paired senders:

```ts
import {
  AampClient,
  consumePairingCode,
  createPairedSenderPolicy,
  createPairingCode,
  parsePairingUrl,
  upsertPairedSenderPolicy,
  type PairedSenderPolicy,
} from 'aamp-sdk'

let activePairing = createPairingCode({ mailbox: identity.email })
let pairedSenders: PairedSenderPolicy[] = []

console.log(activePairing.connectUrl)
// aamp://connect?mailbox=agent%40meshmail.ai&pair_code=...

client.on('pair.request', async (request) => {
  const consumed = consumePairingCode(activePairing, {
    mailbox: identity.email,
    pairCode: request.pairCode,
  })

  if (!consumed) {
    await client.sendPairRespond({
      to: request.from,
      taskId: request.taskId,
      success: false,
      error: 'invalid or expired pair code',
      inReplyTo: request.messageId,
    })
    return
  }

  activePairing = consumed
  pairedSenders = upsertPairedSenderPolicy(
    pairedSenders,
    createPairedSenderPolicy(request),
  )

  await client.sendPairRespond({
    to: request.from,
    taskId: request.taskId,
    success: true,
    inReplyTo: request.messageId,
  })
})

const scanned = parsePairingUrl('aamp://connect?mailbox=agent%40meshmail.ai&pair_code=...')
await client.sendPairRequest({
  to: scanned.mailbox,
  pairCode: scanned.pairCode,
})
```

`pair.request` is the only intent that receivers should evaluate before normal
sender policy. The one-time code should be accepted once, within its TTL, then
destroyed. Every receiver must reply with `pair.respond` using the same
`taskId`; failed responses should set `success: false` and include a reason.
Use `matchPairedSenderPolicy()` in your normal `task.dispatch` gate if you want
the same sender-policy semantics as the bundled bridges.

## Priority, expiry, and cancel

```ts
await client.sendTask({
  to: 'agent@example.com',
  title: 'Prepare a production demo',
  priority: 'urgent',
  expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
})

await client.sendCancel({
  to: 'agent@example.com',
  taskId: '<task-id>',
  bodyText: 'The upstream request was cancelled.',
})
```

## Exports

- `AampClient`
- `JmapPushClient`
- `SmtpSender`
- `createPairingCode`, `buildPairingUrl`, `parsePairingUrl`, `isPairingUrl`
- `consumePairingCode`, `createPairedSenderPolicy`, `upsertPairedSenderPolicy`, `matchPairedSenderPolicy`
- protocol types such as `TaskDispatch`, `TaskCancel`, `TaskResult`, `TaskHelp`, `TaskStreamOpened`, `PairRequest`, and `PairRespond`
