import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setImmediate as waitForNextTick } from 'node:timers/promises'

class FakeEmitter {
  private handlers = new Map<string, Array<(...args: any[]) => void>>()

  on(event: string, handler: (...args: any[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }

  emit(event: string, ...args: any[]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(...args)
    }
  }
}

let lastJmapClient: FakeJmapPushClient | null = null
let lastSmtpSender: FakeSmtpSender | null = null

class FakeJmapPushClient extends FakeEmitter {
  connected = false
  polling = false

  constructor(public readonly opts: Record<string, unknown>) {
    super()
    lastJmapClient = this
  }

  async start(): Promise<void> {
    this.connected = true
  }

  stop(): void {
    this.connected = false
  }

  isConnected(): boolean {
    return this.connected
  }

  isUsingPollingFallback(): boolean {
    return this.polling
  }

  async reconcileRecentEmails(): Promise<number> {
    return 0
  }

  async downloadBlob(): Promise<Buffer> {
    return Buffer.from('blob')
  }
}

class FakeSmtpSender {
  static fromMailboxIdentity = vi.fn((config: Record<string, unknown>) => new FakeSmtpSender(config))
  sendAck = vi.fn()
  sendTask = vi.fn().mockResolvedValue({ taskId: 'task-1', messageId: 'msg-1' })
  sendResult = vi.fn().mockResolvedValue(undefined)
  sendHelp = vi.fn().mockResolvedValue(undefined)
  sendCancel = vi.fn().mockResolvedValue(undefined)
  sendCardQuery = vi.fn().mockResolvedValue({ taskId: 'card-1', messageId: 'msg-card' })
  sendCardResponse = vi.fn().mockResolvedValue(undefined)
  verify = vi.fn().mockResolvedValue(true)
  close = vi.fn()

  constructor(public readonly config: Record<string, unknown>) {
    lastSmtpSender = this
  }
}

const deriveMailboxServiceDefaults = vi.fn((email: string, baseUrl?: string) => ({
  smtpHost: email.split('@')[1],
  httpBaseUrl: baseUrl,
}))

describe('AampClient', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    lastJmapClient = null
    lastSmtpSender = null

    vi.doMock('../src/jmap-push.js', () => ({
      JmapPushClient: FakeJmapPushClient,
    }))
    vi.doMock('../src/smtp-sender.js', () => ({
      SmtpSender: FakeSmtpSender,
      deriveMailboxServiceDefaults,
    }))
  })

  it('wires JMAP events and auto-ack through the SMTP sender', async () => {
    const { AampClient } = await import('../src/client.js')
    const client = new AampClient({
      email: 'agent@meshmail.ai',
      mailboxToken: Buffer.from('agent@meshmail.ai:password-1').toString('base64'),
      baseUrl: 'https://meshmail.ai',
    })

    const seen: Array<{ event: string; payload: unknown }> = []
    client.on('task.dispatch', (payload) => seen.push({ event: 'task.dispatch', payload }))

    await client.connect()
    lastJmapClient!.emit('task.dispatch', { taskId: 'task-7', from: 'sender@meshmail.ai', title: 'Review' })
    lastJmapClient!.emit('_autoAck', { to: 'sender@meshmail.ai', taskId: 'task-7', messageId: '<mid-7>' })
    await waitForNextTick()

    expect(seen).toHaveLength(1)
    expect(seen[0].payload).toMatchObject({ taskId: 'task-7', title: 'Review' })
    expect(lastSmtpSender!.sendAck).toHaveBeenCalledWith({
      to: 'sender@meshmail.ai',
      taskId: 'task-7',
      inReplyTo: '<mid-7>',
    })
    expect(client.isConnected()).toBe(true)
  })

  it('limits concurrent task.dispatch handlers and queues overflow work', async () => {
    const { AampClient } = await import('../src/client.js')
    const client = new AampClient({
      email: 'agent@meshmail.ai',
      mailboxToken: Buffer.from('agent@meshmail.ai:password-1').toString('base64'),
      baseUrl: 'https://meshmail.ai',
      taskDispatchConcurrency: 2,
    })

    let active = 0
    let maxActive = 0
    const started: string[] = []
    const releases = new Map<string, () => void>()

    client.on('task.dispatch', async (task) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      started.push(task.taskId)
      await new Promise<void>((resolve) => {
        releases.set(task.taskId, () => {
          active -= 1
          resolve()
        })
      })
    })

    await client.connect()

    lastJmapClient!.emit('task.dispatch', { taskId: 'task-1', from: 'sender@meshmail.ai', title: 'One' })
    lastJmapClient!.emit('task.dispatch', { taskId: 'task-2', from: 'sender@meshmail.ai', title: 'Two' })
    lastJmapClient!.emit('task.dispatch', { taskId: 'task-3', from: 'sender@meshmail.ai', title: 'Three' })
    await waitForNextTick()

    expect(started).toEqual(['task-1', 'task-2'])
    expect(maxActive).toBe(2)

    releases.get('task-1')?.()
    await waitForNextTick()

    expect(started).toEqual(['task-1', 'task-2', 'task-3'])
    expect(maxActive).toBe(2)

    releases.get('task-2')?.()
    releases.get('task-3')?.()
    await waitForNextTick()
  })

  it('forwards card intents from JMAP and sends card messages through SMTP sender', async () => {
    const { AampClient } = await import('../src/client.js')
    const client = new AampClient({
      email: 'agent@meshmail.ai',
      mailboxToken: Buffer.from('agent@meshmail.ai:password-1').toString('base64'),
      baseUrl: 'https://meshmail.ai',
    })

    const seen: Array<{ event: string; payload: unknown }> = []
    client.on('card.query', (payload) => seen.push({ event: 'card.query', payload }))
    client.on('card.response', (payload) => seen.push({ event: 'card.response', payload }))

    await client.connect()
    lastJmapClient!.emit('card.query', {
      taskId: 'card-7',
      from: 'dispatcher@meshmail.ai',
      to: 'agent@meshmail.ai',
      subject: '[AAMP Card Query] card-7',
      bodyText: 'What can you help with?',
    })
    lastJmapClient!.emit('card.response', {
      taskId: 'card-7',
      from: 'agent@meshmail.ai',
      to: 'dispatcher@meshmail.ai',
      summary: 'I can review code and triage alerts.',
      subject: '[AAMP Card] I can review code and triage alerts.',
      bodyText: 'Full capability card body',
    })

    const queryResult = await client.sendCardQuery({
      to: 'dispatcher@meshmail.ai',
      bodyText: 'Please share your card.',
    })
    await client.sendCardResponse({
      to: 'dispatcher@meshmail.ai',
      taskId: 'card-7',
      summary: 'I can review code and triage alerts.',
      bodyText: 'Full capability card body',
    })

    expect(seen).toEqual([
      {
        event: 'card.query',
        payload: expect.objectContaining({
          taskId: 'card-7',
          bodyText: 'What can you help with?',
        }),
      },
      {
        event: 'card.response',
        payload: expect.objectContaining({
          taskId: 'card-7',
          summary: 'I can review code and triage alerts.',
        }),
      },
    ])
    expect(queryResult).toEqual({ taskId: 'card-1', messageId: 'msg-card' })
    expect(lastSmtpSender!.sendCardQuery).toHaveBeenCalledWith({
      to: 'dispatcher@meshmail.ai',
      bodyText: 'Please share your card.',
    })
    expect(lastSmtpSender!.sendCardResponse).toHaveBeenCalledWith({
      to: 'dispatcher@meshmail.ai',
      taskId: 'card-7',
      summary: 'I can review code and triage alerts.',
      bodyText: 'Full capability card body',
    })
  })

  it('builds registered-command dispatch bodies through the SDK helper', async () => {
    const { AampClient } = await import('../src/client.js')
    const client = new AampClient({
      email: 'agent@meshmail.ai',
      mailboxToken: Buffer.from('agent@meshmail.ai:password-1').toString('base64'),
      baseUrl: 'https://meshmail.ai',
    })

    await client.sendRegisteredCommand({
      to: 'worker@meshmail.ai',
      command: 'git.apply',
      args: { mode: 'check' },
      inputs: [{ slot: 'patch_file', attachmentName: 'fix.diff' }],
      attachments: [{
        filename: 'fix.diff',
        contentType: 'text/plain',
        content: Buffer.from('diff --git a/file b/file'),
      }],
      streamMode: 'status-only',
      dispatchContext: { project_key: 'proj-1' },
    })

    expect(lastSmtpSender!.sendTask).toHaveBeenCalledWith(expect.objectContaining({
      to: 'worker@meshmail.ai',
      title: 'Registered command: git.apply',
      dispatchContext: { project_key: 'proj-1' },
      attachments: [expect.objectContaining({ filename: 'fix.diff' })],
    }))

    const rawBodyText = String(lastSmtpSender!.sendTask.mock.calls[0][0].rawBodyText)
    expect(JSON.parse(rawBodyText)).toEqual({
      kind: 'registered-command/v1',
      command: 'git.apply',
      args: { mode: 'check' },
      inputs: [{ slot: 'patch_file', attachmentName: 'fix.diff' }],
      stream: { mode: 'status-only' },
    })
  })

  it('registers a mailbox through discovered AAMP endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ api: { url: '/api/aamp' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ registrationCode: 'reg-123' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ api: { url: '/api/aamp' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        email: 'agent@meshmail.ai',
        mailbox: { token: 'token-1' },
        smtp: { password: 'smtp-1' },
      })))
    vi.stubGlobal('fetch', fetchMock)

    const { AampClient } = await import('../src/client.js')
    await expect(AampClient.registerMailbox({
      aampHost: 'https://meshmail.ai',
      slug: 'agent',
      description: 'registered in tests',
    })).resolves.toEqual({
      email: 'agent@meshmail.ai',
      mailboxToken: 'token-1',
      smtpPassword: 'smtp-1',
      baseUrl: 'https://meshmail.ai',
    })

    expect(String(fetchMock.mock.calls[1][0])).toBe('https://meshmail.ai/api/aamp?action=aamp.mailbox.register')
    expect(String(fetchMock.mock.calls[3][0])).toBe('https://meshmail.ai/api/aamp?action=aamp.mailbox.credentials&code=reg-123')
  })

  it('rejects malformed mailbox tokens early', async () => {
    const { AampClient } = await import('../src/client.js')
    expect(() => new AampClient({
      email: 'agent@meshmail.ai',
      mailboxToken: '%%%not-base64%%%',
      baseUrl: 'https://meshmail.ai',
    })).toThrow(/Failed to decode mailboxToken|Invalid mailboxToken/)
  })

  it('fetches thread history and hydrates task dispatch context', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ api: { url: '/api/aamp' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        taskId: 'task-9',
        events: [
          {
            intent: 'task.dispatch',
            from: 'sender@meshmail.ai',
            to: 'agent@meshmail.ai',
            title: 'Original task',
            bodyText: 'Write the PRD.',
            messageId: '<dispatch-1>',
            createdAt: '2026-04-14T01:45:15.000Z',
          },
          {
            intent: 'task.help_needed',
            from: 'agent@meshmail.ai',
            to: 'sender@meshmail.ai',
            question: 'Please authorize the plugin.',
            blockedReason: 'Waiting for oauth grant',
            messageId: '<help-1>',
            createdAt: '2026-04-14T01:46:15.000Z',
          },
          {
            intent: 'task.dispatch',
            from: 'sender@meshmail.ai',
            to: 'agent@meshmail.ai',
            title: 'Authorized',
            bodyText: '已授权',
            messageId: '<dispatch-2>',
            createdAt: '2026-04-14T01:47:15.000Z',
          },
        ],
      })))
    vi.stubGlobal('fetch', fetchMock)

    const { AampClient } = await import('../src/client.js')
    const client = new AampClient({
      email: 'agent@meshmail.ai',
      mailboxToken: Buffer.from('agent@meshmail.ai:password-1').toString('base64'),
      baseUrl: 'https://meshmail.ai',
    })

    const hydrated = await client.hydrateTaskDispatch({
      protocolVersion: '1.1',
      intent: 'task.dispatch',
      taskId: 'task-9',
      title: 'Authorized',
      priority: 'normal',
      from: 'sender@meshmail.ai',
      to: 'agent@meshmail.ai',
      messageId: '<dispatch-2>',
      subject: '[AAMP Task] Authorized',
      bodyText: '已授权',
    })

    expect(String(fetchMock.mock.calls[1][0])).toBe('https://meshmail.ai/api/aamp?action=aamp.mailbox.thread&taskId=task-9')
    expect(hydrated.threadHistory).toHaveLength(2)
    expect(hydrated.threadContextText).toContain('Prior thread context:')
    expect(hydrated.threadContextText).toContain('Please authorize the plugin')
    expect(hydrated.threadContextText).not.toContain('已授权')
  })

  it('coalesces rapid A-Z text.delta appends per stream while preserving final receive order', async () => {
    const streamEvents = new Map<string, Array<{
      id: string
      streamId: string
      taskId: string
      seq: number
      timestamp: string
      type: 'text.delta'
      payload: { text: string }
    }>>()
    const streamSeq = new Map<string, number>()
    const orderedTokens = Array.from({ length: 26 }, (_value, index) =>
      String.fromCharCode('A'.charCodeAt(0) + index),
    )

    const discoveryDoc = {
      api: { url: '/api/aamp' },
      capabilities: {
        stream: {
          transport: 'sse',
          createAction: 'aamp.stream.create',
          appendAction: 'aamp.stream.append',
          closeAction: 'aamp.stream.close',
          getAction: 'aamp.stream.get',
          subscribeUrlTemplate: '/api/aamp/streams/{streamId}/events',
        },
      },
    }

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/.well-known/aamp') {
        return new Response(JSON.stringify(discoveryDoc), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.pathname === '/api/aamp') {
        const action = url.searchParams.get('action')
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}

        if (action === 'aamp.stream.create') {
          const streamId = 'str_sdk_ordering'
          streamEvents.set(streamId, [])
          streamSeq.set(streamId, 0)
          return new Response(JSON.stringify({
            streamId,
            taskId: body.taskId,
            ownerEmail: 'agent@meshmail.ai',
            peerEmail: body.peerEmail,
            status: 'created',
            createdAt: '2026-04-16T10:00:00.000Z',
          }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (action === 'aamp.stream.append') {
          const streamId = String(body.streamId)
          const payload = (body.payload ?? {}) as { text?: string }
          const text = String(payload.text ?? '')
          const delay = ((text.charCodeAt(0) || 0) * 7) % 11
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay))
          }
          const nextSeq = (streamSeq.get(streamId) ?? 0) + 1
          streamSeq.set(streamId, nextSeq)
          const event = {
            id: String(nextSeq),
            streamId,
            taskId: 'task-sdk-ordering',
            seq: nextSeq,
            timestamp: `2026-04-16T10:00:0${nextSeq}.000Z`,
            type: 'text.delta' as const,
            payload: { text },
          }
          streamEvents.get(streamId)?.push(event)
          return new Response(JSON.stringify(event), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }

      const streamMatch = url.pathname.match(/^\/api\/aamp\/streams\/([^/]+)\/events$/)
      if (streamMatch) {
        const streamId = decodeURIComponent(streamMatch[1] ?? '')
        const encoder = new TextEncoder()
        const events = streamEvents.get(streamId) ?? []
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events) {
              controller.enqueue(encoder.encode(
                `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              ))
            }
            controller.close()
          },
        })
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }

      throw new Error(`Unexpected fetch URL in SDK ordering test: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { AampClient } = await import('../src/client.js')
    const client = new AampClient({
      email: 'agent@meshmail.ai',
      mailboxToken: Buffer.from('agent@meshmail.ai:password-1').toString('base64'),
      baseUrl: 'https://meshmail.ai',
    })

    const created = await client.createStream({
      taskId: 'task-sdk-ordering',
      peerEmail: 'dispatcher@meshmail.ai',
    })

    const appendPromises: Array<Promise<unknown>> = []
    for (const token of orderedTokens) {
      appendPromises.push(client.appendStreamEvent({
        streamId: created.streamId,
        type: 'text.delta',
        payload: { text: token },
      }))
    }
    await Promise.all(appendPromises)

    const received: Array<{ id?: string; seq: number; text: string }> = []
    await client.subscribeStream(created.streamId, {
      onEvent: (event) => {
        if (event.type !== 'text.delta') return
        received.push({
          id: event.id,
          seq: event.seq,
          text: String(event.payload.text ?? ''),
        })
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const appendCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('action=aamp.stream.append'),
    )

    expect(received.map((event) => event.seq)).toEqual([1, 2])
    expect(received).toHaveLength(2)
    expect(received.map((event) => event.text).join('')).toBe(orderedTokens.join(''))
    expect(appendCalls).toHaveLength(2)
  })

  it('preserves A-Z order when each appendStreamEvent is awaited before sending the next token', async () => {
    const streamEvents = new Map<string, Array<{
      id: string
      streamId: string
      taskId: string
      seq: number
      timestamp: string
      type: 'text.delta'
      payload: { text: string }
    }>>()
    const streamSeq = new Map<string, number>()
    const orderedTokens = Array.from({ length: 26 }, (_value, index) =>
      String.fromCharCode('A'.charCodeAt(0) + index),
    )

    const discoveryDoc = {
      api: { url: '/api/aamp' },
      capabilities: {
        stream: {
          transport: 'sse',
          createAction: 'aamp.stream.create',
          appendAction: 'aamp.stream.append',
          closeAction: 'aamp.stream.close',
          getAction: 'aamp.stream.get',
          subscribeUrlTemplate: '/api/aamp/streams/{streamId}/events',
        },
      },
    }

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      if (url.pathname === '/.well-known/aamp') {
        return new Response(JSON.stringify(discoveryDoc), {
          headers: { 'Content-Type': 'application/json' },
        })
      }

      if (url.pathname === '/api/aamp') {
        const action = url.searchParams.get('action')
        const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}

        if (action === 'aamp.stream.create') {
          const streamId = 'str_sdk_ordering_sequential'
          streamEvents.set(streamId, [])
          streamSeq.set(streamId, 0)
          return new Response(JSON.stringify({
            streamId,
            taskId: body.taskId,
            ownerEmail: 'agent@meshmail.ai',
            peerEmail: body.peerEmail,
            status: 'created',
            createdAt: '2026-04-16T10:00:00.000Z',
          }), {
            headers: { 'Content-Type': 'application/json' },
          })
        }

        if (action === 'aamp.stream.append') {
          const streamId = String(body.streamId)
          const text = String((body.payload as { text?: string } | undefined)?.text ?? '')
          const delay = ((text.charCodeAt(0) || 0) * 7) % 11
          if (delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, delay))
          }
          const nextSeq = (streamSeq.get(streamId) ?? 0) + 1
          streamSeq.set(streamId, nextSeq)
          const event = {
            id: String(nextSeq),
            streamId,
            taskId: 'task-sdk-ordering-sequential',
            seq: nextSeq,
            timestamp: `2026-04-16T10:01:${String(nextSeq).padStart(2, '0')}.000Z`,
            type: 'text.delta' as const,
            payload: { text },
          }
          streamEvents.get(streamId)?.push(event)
          return new Response(JSON.stringify(event), {
            headers: { 'Content-Type': 'application/json' },
          })
        }
      }

      const streamMatch = url.pathname.match(/^\/api\/aamp\/streams\/([^/]+)\/events$/)
      if (streamMatch) {
        const streamId = decodeURIComponent(streamMatch[1] ?? '')
        const encoder = new TextEncoder()
        const events = streamEvents.get(streamId) ?? []
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            for (const event of events) {
              controller.enqueue(encoder.encode(
                `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              ))
            }
            controller.close()
          },
        })
        return new Response(body, {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }

      throw new Error(`Unexpected fetch URL in sequential SDK ordering test: ${url}`)
    })

    vi.stubGlobal('fetch', fetchMock)

    const { AampClient } = await import('../src/client.js')
    const client = new AampClient({
      email: 'agent@meshmail.ai',
      mailboxToken: Buffer.from('agent@meshmail.ai:password-1').toString('base64'),
      baseUrl: 'https://meshmail.ai',
    })

    const created = await client.createStream({
      taskId: 'task-sdk-ordering-sequential',
      peerEmail: 'dispatcher@meshmail.ai',
    })

    for (const token of orderedTokens) {
      await client.appendStreamEvent({
        streamId: created.streamId,
        type: 'text.delta',
        payload: { text: token },
      })
    }

    const received: Array<{ id?: string; seq: number; text: string }> = []
    await client.subscribeStream(created.streamId, {
      onEvent: (event) => {
        if (event.type !== 'text.delta') return
        received.push({
          id: event.id,
          seq: event.seq,
          text: String(event.payload.text ?? ''),
        })
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 50))

    const appendCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('action=aamp.stream.append'),
    )

    expect(received.map((event) => event.seq)).toEqual(
      Array.from({ length: orderedTokens.length }, (_value, index) => index + 1),
    )
    expect(received).toHaveLength(orderedTokens.length)
    expect(received.map((event) => event.text).join('')).toBe(orderedTokens.join(''))
    expect(appendCalls).toHaveLength(orderedTokens.length)
  })
})
