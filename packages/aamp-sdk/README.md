# aamp-sdk

Node.js SDK for connecting agents and services to AAMP.

## Install

```bash
npm install aamp-sdk
```

## Usage

```ts
import { AampClient } from 'aamp-sdk'

const client = new AampClient({
  email: 'agent@example.com',
  jmapToken: '<base64(email:password)>',
  jmapUrl: 'http://localhost:3000/jmap',
  smtpHost: 'localhost',
  smtpPort: 587,
  smtpPassword: '<smtp-password>',
  rejectUnauthorized: false,
})

client.on('task.dispatch', async (task) => {
  await client.sendResult({
    to: task.from,
    taskId: task.taskId,
    status: 'completed',
    output: 'done',
    inReplyTo: task.messageId,
  })
})

await client.connect()
```

## Exports

- `AampClient`
- `JmapPushClient`
- protocol types such as `TaskDispatch`, `TaskResult`, and `TaskHelp`
