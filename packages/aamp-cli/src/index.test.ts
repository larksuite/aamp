import { mkdtempSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeClient {
  private handlers = new Map<string, Array<(...args: any[]) => void>>()
  email = 'agent@meshmail.ai'
  sendTask = vi.fn().mockResolvedValue({ taskId: 'task-1', messageId: 'msg-1' })
  sendResult = vi.fn().mockResolvedValue(undefined)
  sendHelp = vi.fn().mockResolvedValue(undefined)
  sendCancel = vi.fn().mockResolvedValue(undefined)
  sendCardQuery = vi.fn().mockResolvedValue({ taskId: 'card-1', messageId: 'msg-card' })
  sendCardResponse = vi.fn().mockResolvedValue(undefined)
  verifySmtp = vi.fn().mockResolvedValue(true)
  connect = vi.fn().mockResolvedValue(undefined)
  disconnect = vi.fn()
  isUsingPollingFallback = vi.fn().mockReturnValue(false)
  getThreadHistory = vi.fn().mockResolvedValue({ taskId: 'task-1', events: [] })
  hydrateTaskDispatch = vi.fn(async (task: any) => ({ ...task, threadHistory: [], threadContextText: '' }))

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
}

const registerMailbox = vi.fn()
const fromMailboxIdentity = vi.fn()
const renderThreadHistoryForAgent = vi.fn((events: Array<{ question?: string }>) => (
  events.length ? `Prior thread context:\n- ${events[0]?.question ?? 'event'}` : ''
))
let tempHome = ''

describe('aamp-cli helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'aamp-cli-test-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome)

    registerMailbox.mockReset()
    fromMailboxIdentity.mockReset()
    fromMailboxIdentity.mockImplementation(() => new FakeClient())

    vi.doMock('aamp-sdk', () => ({
      AampClient: {
        registerMailbox,
        fromMailboxIdentity,
      },
      renderThreadHistoryForAgent,
    }))
  })

  it('writes init profiles with derived defaults', async () => {
    const cli = await import('./index.ts')
    const args = cli.parseArgs([
      'init',
      '--email', 'worker@meshmail.ai',
      '--password', 'smtp-1',
      '--profile', 'demo',
    ])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await cli.runInit(args)

    const profile = JSON.parse(readFileSync(path.join(tempHome, '.aamp-cli', 'profiles', 'demo.json'), 'utf8'))
    expect(profile).toMatchObject({
      email: 'worker@meshmail.ai',
      smtpPassword: 'smtp-1',
      baseUrl: 'https://meshmail.ai',
      smtpHost: 'meshmail.ai',
      smtpPort: 587,
      rejectUnauthorized: true,
    })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Saved profile "demo"'))
  })

  it('registers a mailbox and persists the returned identity', async () => {
    registerMailbox.mockResolvedValue({
      email: 'registered@meshmail.ai',
      smtpPassword: 'smtp-registered',
      mailboxToken: 'mailbox-token',
      baseUrl: 'https://meshmail.ai',
    })

    const cli = await import('./index.ts')
    const args = cli.parseArgs([
      'register',
      '--host', 'https://meshmail.ai',
      '--slug', 'OpenClaw Agent',
      '--profile', 'demo',
    ])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await cli.runRegister(args)

    expect(registerMailbox).toHaveBeenCalledWith(expect.objectContaining({
      aampHost: 'https://meshmail.ai',
      slug: 'openclaw-agent',
    }))
    const saved = JSON.parse(readFileSync(path.join(tempHome, '.aamp-cli', 'profiles', 'demo.json'), 'utf8'))
    expect(saved.email).toBe('registered@meshmail.ai')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"profile": "demo"'))
  })

  it('dispatches tasks through the SDK client', async () => {
    const cli = await import('./index.ts')
    const profilePath = path.join(tempHome, '.aamp-cli', 'profiles', 'default.json')
    const profile = {
      email: 'worker@meshmail.ai',
      smtpPassword: 'smtp-1',
      baseUrl: 'https://meshmail.ai',
      smtpHost: 'meshmail.ai',
      smtpPort: 587,
      rejectUnauthorized: true,
    }
    await mkdir(path.dirname(profilePath), { recursive: true })
    await writeFile(profilePath, JSON.stringify(profile), 'utf8')

    const args = cli.parseArgs([
      'dispatch',
      '--to', 'reviewer@meshmail.ai',
      '--title', 'Review PR',
      '--body', 'Please review the change.',
      '--context-link', 'https://example.com/pr/42',
    ])
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await cli.runDispatch(args)

    const client = fromMailboxIdentity.mock.results[0].value as FakeClient
    expect(client.sendTask).toHaveBeenCalledWith(expect.objectContaining({
      to: 'reviewer@meshmail.ai',
      title: 'Review PR',
      bodyText: 'Please review the change.',
      contextLinks: ['https://example.com/pr/42'],
    }))
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"taskId": "task-1"'))
  })

  it('logs inbound dispatch and result events for listen mode', async () => {
    const cli = await import('./index.ts')
    const client = new FakeClient()
    const messages: string[] = []
    const logger = {
      log: (message: string) => messages.push(message),
      error: (message: string) => messages.push(message),
    }

    cli.attachListenHandlers(client as never, logger)
    client.emit('task.dispatch', {
      taskId: 'task-3',
      from: 'dispatcher@meshmail.ai',
      title: 'Review protocol',
      priority: 'high',
      contextLinks: ['https://example.com/context'],
      bodyText: 'Please compare the latest headers.',
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    client.emit('task.result', {
      taskId: 'task-3',
      from: 'worker@meshmail.ai',
      status: 'completed',
      output: 'Done.',
    })

    expect(messages.join('\n')).toContain('task.dispatch task-3')
    expect(messages.join('\n')).toContain('Please compare the latest headers.')
    expect(messages.join('\n')).toContain('task.result task-3')
  })

  it('fetches thread history through the SDK client', async () => {
    const cli = await import('./index.ts')
    const profilePath = path.join(tempHome, '.aamp-cli', 'profiles', 'default.json')
    const profile = {
      email: 'worker@meshmail.ai',
      smtpPassword: 'smtp-1',
      baseUrl: 'https://meshmail.ai',
      smtpHost: 'meshmail.ai',
      smtpPort: 587,
      rejectUnauthorized: true,
    }
    await mkdir(path.dirname(profilePath), { recursive: true })
    await writeFile(profilePath, JSON.stringify(profile), 'utf8')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const client = new FakeClient()
    client.getThreadHistory.mockResolvedValue({
      taskId: 'task-42',
      events: [
        {
          intent: 'task.help_needed',
          from: 'agent@meshmail.ai',
          to: 'sender@meshmail.ai',
          question: 'Need authorization',
          blockedReason: 'OAuth required',
          createdAt: '2026-04-14T01:46:15.000Z',
        },
      ],
    })
    fromMailboxIdentity.mockImplementation(() => client)

    await cli.runThread(cli.parseArgs([
      'thread',
      '--task-id', 'task-42',
    ]))

    expect(client.getThreadHistory).toHaveBeenCalledWith('task-42', {
      includeStreamOpened: false,
    })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"taskId": "task-42"'))
  })

  it('sends card.query and card.response commands through the SDK client', async () => {
    const cli = await import('./index.ts')
    const profilePath = path.join(tempHome, '.aamp-cli', 'profiles', 'default.json')
    const profile = {
      email: 'worker@meshmail.ai',
      smtpPassword: 'smtp-1',
      baseUrl: 'https://meshmail.ai',
      smtpHost: 'meshmail.ai',
      smtpPort: 587,
      rejectUnauthorized: true,
    }
    await mkdir(path.dirname(profilePath), { recursive: true })
    await writeFile(profilePath, JSON.stringify(profile), 'utf8')

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await cli.runCardQuery(cli.parseArgs([
      'card-query',
      '--to', 'reviewer@meshmail.ai',
      '--body', 'Please share your capability card.',
    ]))

    const queryClient = fromMailboxIdentity.mock.results[0].value as FakeClient
    expect(queryClient.sendCardQuery).toHaveBeenCalledWith({
      to: 'reviewer@meshmail.ai',
      bodyText: 'Please share your capability card.',
    })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"taskId": "card-1"'))

    const cardFile = path.join(tempHome, 'card.md')
    await writeFile(cardFile, 'Capability card body from file', 'utf8')

    await cli.runCardResponse(cli.parseArgs([
      'card-response',
      '--to', 'reviewer@meshmail.ai',
      '--task-id', 'card-1',
      '--summary', 'Reviews code and summarizes incidents',
      '--card-file', cardFile,
    ]))

    const responseClient = fromMailboxIdentity.mock.results[1].value as FakeClient
    expect(responseClient.sendCardResponse).toHaveBeenCalledWith({
      to: 'reviewer@meshmail.ai',
      taskId: 'card-1',
      summary: 'Reviews code and summarizes incidents',
      bodyText: 'Capability card body from file',
    })
    expect(logSpy).toHaveBeenCalledWith('Sent card.response for card-1')
  })

  it('logs inbound card.query and card.response events for listen mode', async () => {
    const cli = await import('./index.ts')
    const client = new FakeClient()
    const messages: string[] = []
    const logger = {
      log: (message: string) => messages.push(message),
      error: (message: string) => messages.push(message),
    }

    cli.attachListenHandlers(client as never, logger)
    client.emit('card.query', {
      taskId: 'card-3',
      from: 'dispatcher@meshmail.ai',
      subject: '[AAMP Card Query] card-3',
      bodyText: 'What services do you provide?',
    })
    client.emit('card.response', {
      taskId: 'card-3',
      from: 'worker@meshmail.ai',
      summary: 'Reviews code and handles incidents',
      bodyText: 'Detailed card body',
    })

    expect(messages.join('\n')).toContain('card.query card-3')
    expect(messages.join('\n')).toContain('What services do you provide?')
    expect(messages.join('\n')).toContain('card.response card-3')
    expect(messages.join('\n')).toContain('Reviews code and handles incidents')
  })
})
