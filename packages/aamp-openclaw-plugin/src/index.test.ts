import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setImmediate as waitForNextTick } from 'node:timers/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeAampClient {
  private handlers = new Map<string, Array<(...args: any[]) => void>>()
  connected = false
  createStream = vi.fn().mockResolvedValue({ streamId: 'stream-1' })
  appendStreamEvent = vi.fn().mockResolvedValue(undefined)
  closeStream = vi.fn().mockResolvedValue(undefined)
  sendStreamOpened = vi.fn().mockResolvedValue(undefined)
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

  it('injects the task targeted by the session key instead of the oldest queued task', async () => {
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
      title: 'Old blocked task',
      bodyText: 'This older task should stay isolated.',
      priority: 'high',
      to: 'agent@meshmail.ai',
    })).toBe(true)

    expect(plugin.queuePendingTask({
      taskId: 'task-43',
      from: 'dispatcher@meshmail.ai',
      title: 'New urgent task',
      bodyText: 'This new task should own its own session.',
      priority: 'normal',
      to: 'agent@meshmail.ai',
    })).toBe(true)

    const beforePromptBuild = handlers.get('before_prompt_build')
    expect(beforePromptBuild).toBeTypeOf('function')

    const targetedPrompt = beforePromptBuild?.('before_prompt_build', {
      sessionKey: 'agent:main:aamp:default:task:task-43',
    }) as { prependContext?: string }

    expect(targetedPrompt.prependContext).toContain('Task ID:  task-43')
    expect(targetedPrompt.prependContext).not.toContain('Task ID:  task-42')
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
      to: 'agent@meshmail.ai',
    })).toBe(true)

    expect(plugin.queuePendingTask({
      taskId: 'task-43',
      from: 'dispatcher@meshmail.ai',
      title: 'Summarize docs',
      bodyText: 'Create a short summary.',
      priority: 'normal',
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

  it('suspends help-waiting tasks so queue wakeups move on to newer work', async () => {
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
    const handlers = new Map<string, (...args: any[]) => unknown>()
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
      on: (event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler)
      },
      registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
        tools.set(tool.name, tool)
      },
      registerCommand: vi.fn(),
    })

    await service!.start()

    expect(plugin.queuePendingTask({
      taskId: 'task-42',
      from: 'dispatcher@meshmail.ai',
      title: 'Need clarification',
      bodyText: 'Old task that is about to ask for help.',
      priority: 'high',
      to: 'agent@meshmail.ai',
    })).toBe(true)

    expect(plugin.queuePendingTask({
      taskId: 'task-43',
      from: 'dispatcher@meshmail.ai',
      title: 'Fresh task',
      bodyText: 'This should be the next actionable task.',
      priority: 'normal',
      to: 'agent@meshmail.ai',
    })).toBe(true)

    const helpTool = tools.get('aamp_send_help')
    await expect(helpTool!.execute('tool-call', {
      taskId: 'task-42',
      question: 'Which document should I use?',
      blockedReason: 'The request does not name the target document.',
    })).resolves.toEqual({
      content: [{
        type: 'text',
        text: 'Help request sent for task task-42. The task is now suspended until the dispatcher replies.',
      }],
    })

    const beforePromptBuild = handlers.get('before_prompt_build')
    expect(beforePromptBuild).toBeTypeOf('function')

    const queuePrompt = beforePromptBuild?.('before_prompt_build', {
      sessionKey: 'aamp:wake:queue:follow-up',
    }) as { prependContext?: string }

    expect(queuePrompt.prependContext).toContain('Task ID:  task-43')
    expect(queuePrompt.prependContext).not.toContain('Task ID:  task-42')

    const pendingTasksTool = tools.get('aamp_pending_tasks')
    await expect(pendingTasksTool!.execute('tool-call', {})).resolves.toEqual({
      content: [{
        type: 'text',
        text: expect.stringContaining('[task-42] "Need clarification" (waiting for dispatcher reply)'),
      }],
    })
  })

  it('keeps the task actionable when sending help fails and leaves the stream open', async () => {
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
    const handlers = new Map<string, (...args: any[]) => unknown>()
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
      on: (event: string, handler: (...args: any[]) => unknown) => {
        handlers.set(event, handler)
      },
      registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
        tools.set(tool.name, tool)
      },
      registerCommand: vi.fn(),
    })

    await service!.start()

    const client = FakeAampClient.fromMailboxIdentity.mock.results[0].value as FakeAampClient
    client.sendHelp.mockRejectedValueOnce(new Error('smtp unavailable'))

    client.emit('task.dispatch', {
      taskId: 'task-42',
      from: 'dispatcher@meshmail.ai',
      title: 'Need clarification',
      bodyText: 'Old task that is about to ask for help.',
      priority: 'high',
      to: 'agent@meshmail.ai',
    })

    await waitForNextTick()

    const helpTool = tools.get('aamp_send_help')
    await expect(helpTool!.execute('tool-call', {
      taskId: 'task-42',
      question: 'Which document should I use?',
      blockedReason: 'The request does not name the target document.',
    })).resolves.toEqual({
      content: [{
        type: 'text',
        text: 'Error: failed to send help request for task task-42: smtp unavailable',
      }],
    })

    expect(client.closeStream).not.toHaveBeenCalledWith(expect.objectContaining({
      payload: { reason: 'task.help_needed' },
    }))
    expect(client.appendStreamEvent).toHaveBeenCalledWith(expect.objectContaining({
      streamId: 'stream-1',
      type: 'error',
      payload: expect.objectContaining({
        message: 'Failed to send help request: smtp unavailable',
      }),
    }))
    expect(logger.error).toHaveBeenCalledWith('[AAMP] aamp_send_help failed for task-42: smtp unavailable')

    const beforePromptBuild = handlers.get('before_prompt_build')
    expect(beforePromptBuild).toBeTypeOf('function')

    const queuePrompt = beforePromptBuild?.('before_prompt_build', {
      sessionKey: 'aamp:wake:queue:follow-up',
    }) as { prependContext?: string }

    expect(queuePrompt.prependContext).toContain('Task ID:  task-42')

    const pendingTasksTool = tools.get('aamp_pending_tasks')
    await expect(pendingTasksTool!.execute('tool-call', {})).resolves.toEqual({
      content: [{
        type: 'text',
        text: expect.not.stringContaining('(waiting for dispatcher reply)'),
      }],
    })
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

  it('does not re-queue a historical dispatch when the thread already has a terminal reply', async () => {
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

    const client = FakeAampClient.fromMailboxIdentity.mock.results[0].value as FakeAampClient
    client.hydrateTaskDispatch.mockResolvedValueOnce({
      taskId: 'task-42',
      from: 'dispatcher@meshmail.ai',
      to: 'agent@meshmail.ai',
      title: '列出目录内容',
      bodyText: '请把 ~/Downloads 目录下所有文件列给我。',
      priority: 'normal',
      messageId: 'msg-dispatch-1',
      threadHistory: [
        {
          intent: 'task.result',
          taskId: 'task-42',
          from: 'agent@meshmail.ai',
          to: 'dispatcher@meshmail.ai',
          status: 'completed',
          output: '~/Downloads 目录下共有 607 个文件/目录（仅一层）。',
          createdAt: '2026-04-22T08:00:00.000Z',
          messageId: 'msg-result-1',
        },
      ],
      threadContextText: 'Prior thread context:\n- [2026-04-22 08:00] agent replied: ~/Downloads 目录下共有 607 个文件/目录（仅一层）。',
    })

    client.emit('task.dispatch', {
      taskId: 'task-42',
      from: 'dispatcher@meshmail.ai',
      to: 'agent@meshmail.ai',
      title: '列出目录内容',
      bodyText: '请把 ~/Downloads 目录下所有文件列给我。',
      priority: 'normal',
      messageId: 'msg-dispatch-1',
    })

    await waitForNextTick()

    expect(requestHeartbeatNow).not.toHaveBeenCalled()

    const pendingTasksTool = tools.get('aamp_pending_tasks')
    await expect(pendingTasksTool!.execute('tool-call', {})).resolves.toEqual({
      content: [{
        type: 'text',
        text: 'No pending AAMP tasks.',
      }],
    })

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining(
      'Skipping historical task task-42 because the thread already reached a terminal state',
    ))
  })
})
