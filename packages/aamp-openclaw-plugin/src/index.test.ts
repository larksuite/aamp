import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as waitForNextTick } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeAampClient {
  private handlers = new Map<string, Array<(...args: any[]) => void>>()
  connected = false
  sendResult = vi.fn().mockResolvedValue(undefined)
  sendHelp = vi.fn().mockResolvedValue(undefined)
  sendTask = vi.fn().mockResolvedValue({ taskId: 'subtask-1', messageId: 'msg-sub-1' })
  disconnect = vi.fn()
  hydrateTaskDispatch = vi.fn(async (task: any) => ({
    ...task,
    threadHistory: task.threadHistory ?? [],
    threadContextText: task.threadContextText ?? '',
  }))
  reconcileRecentEmails = vi.fn().mockResolvedValue(0)
  isUsingPollingFallback = vi.fn().mockReturnValue(false)

  static fromMailboxIdentity = vi.fn(() => new FakeAampClient())

  on(event: string, handler: (...args: any[]) => void): void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload)
    }
  }

  async connect(): Promise<void> {
    this.connected = true
    this.emit('connected', undefined)
  }

  isConnected(): boolean {
    return this.connected
  }
}

describe('openclaw plugin runtime', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.resetModules()
    vi.restoreAllMocks()
    const home = mkdtempSync(path.join(os.tmpdir(), 'aamp-openclaw-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os')
      return { ...actual, homedir: () => home }
    })
    FakeAampClient.fromMailboxIdentity.mockClear()
  })

  it('connects, surfaces inbound tasks, and sends task results', async () => {
    const home = process.env.HOME!
    const credentialsFile = path.join(home, '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.credentials.json')
    mkdirSync(path.dirname(credentialsFile), { recursive: true })
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'agent@meshmail.ai',
      mailboxToken: 'mailbox-token',
      smtpPassword: 'smtp-1',
    }))

    vi.doMock('aamp-sdk', () => ({
      AampClient: FakeAampClient,
    }))

    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>()
    let service: { start: () => Promise<void> } | null = null

    const plugin = await import('./index.ts')
    plugin.default.register({
      config: {
        channels: {
          aamp: {
            aampHost: 'https://meshmail.ai',
            credentialsFile,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        system: {
          requestHeartbeatNow: vi.fn(),
        },
      },
      registerChannel: vi.fn(),
      registerService: (value: { start: () => Promise<void> }) => {
        service = value
      },
      on: vi.fn(),
      registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
        tools.set(tool.name, tool)
      },
      registerCommand: vi.fn(),
    })

    await service!.start()

    const client = FakeAampClient.fromMailboxIdentity.mock.results[0].value as FakeAampClient
    expect(plugin.queuePendingTask({
      taskId: 'task-42',
      from: 'dispatcher@meshmail.ai',
      title: 'Review docs',
      bodyText: 'Please compare the latest protocol docs.',
      priority: 'high',
      contextLinks: ['https://example.com/context'],
      to: 'agent@meshmail.ai',
    })).toBe(true)

    const resultTool = tools.get('aamp_send_result')
    await expect(resultTool!.execute('tool-call', {
      taskId: 'task-42',
      status: 'completed',
      output: 'Reviewed and approved.',
    })).resolves.toEqual({
      content: [{
        type: 'text',
        text: 'Result sent for task task-42 (status: completed).',
      }],
    })
    expect(client.sendResult).toHaveBeenCalledWith(expect.objectContaining({
      to: 'dispatcher@meshmail.ai',
      taskId: 'task-42',
      status: 'completed',
      output: 'Reviewed and approved.',
    }))
  })

  it('does not inject pending AAMP task context into normal chat sessions', async () => {
    vi.doMock('aamp-sdk', () => ({
      AampClient: FakeAampClient,
    }))

    const handlers = new Map<string, (...args: any[]) => unknown>()

    const plugin = await import('./index.ts')
    plugin.default.register({
      config: {
        channels: {
          aamp: {
            aampHost: 'https://meshmail.ai',
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        system: {
          requestHeartbeatNow: vi.fn(),
        },
      },
      registerChannel: vi.fn(),
      registerService: vi.fn(),
      on: (event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler)
      },
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    })

    expect(plugin.queuePendingTask({
      taskId: 'task-42',
      from: 'dispatcher@meshmail.ai',
      title: 'Review docs',
      bodyText: 'Please compare the latest protocol docs.',
      priority: 'high',
      contextLinks: ['https://example.com/context'],
      to: 'agent@meshmail.ai',
    })).toBe(true)

    const beforePromptBuild = handlers.get('before_prompt_build')
    expect(beforePromptBuild).toBeTypeOf('function')

    expect(beforePromptBuild?.('before_prompt_build', { sessionKey: 'agent:main:main' })).toEqual({})

    expect(beforePromptBuild?.('before_prompt_build', {
      sessionKey: 'aamp:wake:task:task-42',
    })).toEqual(expect.objectContaining({
      prependContext: expect.stringContaining('Task ID:  task-42'),
    }))

    expect(beforePromptBuild?.('before_prompt_build', {
      sessionKey: 'agent:main:aamp:default:task:task-42',
    })).toEqual(expect.objectContaining({
      prependContext: expect.stringContaining('Task ID:  task-42'),
    }))
  })

  it('uses isolated AAMP wake sessions when more tasks remain after sending a result', async () => {
    const home = process.env.HOME!
    const credentialsFile = path.join(home, '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.credentials.json')
    mkdirSync(path.dirname(credentialsFile), { recursive: true })
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'agent@meshmail.ai',
      mailboxToken: 'mailbox-token',
      smtpPassword: 'smtp-1',
    }))

    vi.doMock('aamp-sdk', () => ({
      AampClient: FakeAampClient,
    }))

    const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>()
    let service: { start: () => Promise<void> } | null = null
    const requestHeartbeatNow = vi.fn()

    const plugin = await import('./index.ts')
    plugin.default.register({
      config: {
        channels: {
          aamp: {
            aampHost: 'https://meshmail.ai',
            credentialsFile,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        system: {
          requestHeartbeatNow,
        },
      },
      registerChannel: vi.fn(),
      registerService: (value: { start: () => Promise<void> }) => {
        service = value
      },
      on: vi.fn(),
      registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
        tools.set(tool.name, tool)
      },
      registerCommand: vi.fn(),
    })

    await service!.start()

    expect(plugin.queuePendingTask({
      taskId: 'task-42',
      from: 'dispatcher@meshmail.ai',
      title: 'Review docs',
      bodyText: 'Please compare the latest protocol docs.',
      priority: 'high',
      contextLinks: ['https://example.com/context'],
      to: 'agent@meshmail.ai',
    })).toBe(true)

    expect(plugin.queuePendingTask({
      taskId: 'task-43',
      from: 'dispatcher@meshmail.ai',
      title: 'Summarize docs',
      bodyText: 'Create a short summary.',
      priority: 'normal',
      contextLinks: [],
      to: 'agent@meshmail.ai',
    })).toBe(true)

    const resultTool = tools.get('aamp_send_result')
    await resultTool!.execute('tool-call', {
      taskId: 'task-42',
      status: 'completed',
      output: 'Reviewed and approved.',
    })

    expect(requestHeartbeatNow).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'wake',
      sessionKey: expect.stringMatching(/^aamp:/),
    }))
  })

  it('uses the OpenClaw agent session alias when dispatching pending tasks', async () => {
    const home = process.env.HOME!
    const credentialsFile = path.join(home, '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.credentials.json')
    mkdirSync(path.dirname(credentialsFile), { recursive: true })
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'agent@meshmail.ai',
      mailboxToken: 'mailbox-token',
      smtpPassword: 'smtp-1',
    }))

    vi.doMock('aamp-sdk', () => ({
      AampClient: FakeAampClient,
    }))

    let service: { start: () => Promise<void> } | null = null
    let channel: any = null
    const dispatcher = vi.fn().mockResolvedValue(undefined)
    const abortController = new AbortController()

    const plugin = await import('./index.ts')
    plugin.default.register({
      config: {
        agents: {
          list: [
            { id: 'ops', default: true },
            { id: 'main' },
          ],
        },
        channels: {
          aamp: {
            aampHost: 'https://meshmail.ai',
            credentialsFile,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      runtime: {
        system: {
          requestHeartbeatNow: vi.fn(),
        },
      },
      registerChannel: (value: unknown) => {
        channel = value
      },
      registerService: (value: { start: () => Promise<void> }) => {
        service = value
      },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    })

    void channel.gateway.startAccount({
      channelRuntime: {
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: dispatcher,
        },
      },
      cfg: {},
      abortSignal: abortController.signal,
    })

    await service!.start()

    const client = FakeAampClient.fromMailboxIdentity.mock.results[0].value as FakeAampClient
    client.emit('task.dispatch', {
      taskId: 'task-42',
      from: 'dispatcher@meshmail.ai',
      title: 'Review docs',
      bodyText: 'Please compare the latest protocol docs.',
      priority: 'high',
      contextLinks: ['https://example.com/context'],
      to: 'agent@meshmail.ai',
    })

    await waitForNextTick()

    expect(client.hydrateTaskDispatch).toHaveBeenCalledWith(expect.objectContaining({
      taskId: 'task-42',
    }))

    expect(dispatcher).toHaveBeenCalledWith(expect.objectContaining({
      ctx: expect.objectContaining({
        SessionKey: 'agent:ops:aamp:default:task:task-42',
      }),
    }))

    abortController.abort()
  })

  it('retries startup historical reconcile until it succeeds', async () => {
    vi.useFakeTimers()

    const home = process.env.HOME!
    const credentialsFile = path.join(home, '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.credentials.json')
    mkdirSync(path.dirname(credentialsFile), { recursive: true })
    writeFileSync(credentialsFile, JSON.stringify({
      email: 'agent@meshmail.ai',
      mailboxToken: 'mailbox-token',
      smtpPassword: 'smtp-1',
    }))

    vi.doMock('aamp-sdk', () => ({
      AampClient: FakeAampClient,
    }))

    let service: { start: () => Promise<void> } | null = null
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    const plugin = await import('./index.ts')
    plugin.default.register({
      config: {
        channels: {
          aamp: {
            aampHost: 'https://meshmail.ai',
            credentialsFile,
          },
        },
      },
      logger,
      runtime: {
        system: {
          requestHeartbeatNow: vi.fn(),
        },
      },
      registerChannel: vi.fn(),
      registerService: (value: { start: () => Promise<void> }) => {
        service = value
      },
      on: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn(),
    })

    const client = new FakeAampClient()
    client.reconcileRecentEmails
      .mockRejectedValueOnce(new Error('jmapCall https://meshmail.ai/jmap/ failed: fetch failed | cause=read ECONNRESET | code=ECONNRESET'))
      .mockResolvedValueOnce(2)
      .mockResolvedValue(0)
    FakeAampClient.fromMailboxIdentity.mockReturnValue(client)

    await service!.start()
    await vi.runAllTicks()
    await Promise.resolve()

    expect(client.reconcileRecentEmails).toHaveBeenNthCalledWith(1, 100, { includeHistorical: true })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('will retry historical tasks'))

    await vi.advanceTimersByTimeAsync(15000)
    expect(client.reconcileRecentEmails).toHaveBeenNthCalledWith(2, 100, { includeHistorical: true })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Historical mailbox reconcile complete'))

    await vi.advanceTimersByTimeAsync(15000)
    expect(client.reconcileRecentEmails).toHaveBeenNthCalledWith(3, 100, undefined)
  })
})
