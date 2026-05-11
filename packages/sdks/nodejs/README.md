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
- `appendStreamEvent()` appends `text.delta`, `progress`, `status`, `artifact`, `error`, or `done`
- `closeStream()` closes the stream before the final `task.result`

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
- protocol types such as `TaskDispatch`, `TaskCancel`, `TaskResult`, `TaskHelp`, and `TaskStreamOpened`
