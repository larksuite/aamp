import { mkdtempSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

class FakeClient {
  private handlers = new Map<string, Array<(...args: any[]) => void>>()
  email = 'agent@meshmail.ai'
  sendTask = vi.fn().mockResolvedValue({ taskId: 'task-1', messageId: 'msg-1' })
  sendRegisteredCommand = vi.fn().mockResolvedValue({ taskId: 'task-cmd-1', messageId: 'msg-cmd-1' })
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
let promptAnswers: string[] = []

describe('aamp-cli helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'aamp-cli-test-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome)

    registerMailbox.mockReset()
    fromMailboxIdentity.mockReset()
    fromMailboxIdentity.mockImplementation(() => new FakeClient())
    promptAnswers = []

    vi.doMock('aamp-sdk', () => ({
      AampClient: {
        registerMailbox,
        fromMailboxIdentity,
      },
      renderThreadHistoryForAgent,
    }))
    vi.doMock('node:readline/promises', () => ({
      default: {
        createInterface: () => ({
          question: async () => promptAnswers.shift() ?? '',
          close: () => {},
        }),
      },
      createInterface: () => ({
        question: async () => promptAnswers.shift() ?? '',
        close: () => {},
      }),
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

  it('node init reuses the default cached mailbox when email is omitted', async () => {
    const profilePath = path.join(tempHome, '.aamp-cli', 'profiles', 'default.json')
    await mkdir(path.dirname(profilePath), { recursive: true })
    await writeFile(profilePath, JSON.stringify({
      email: 'cached@meshmail.ai',
      smtpPassword: 'cached-smtp',
      baseUrl: 'https://meshmail.ai',
      smtpHost: 'meshmail.ai',
      smtpPort: 587,
      rejectUnauthorized: true,
    }), 'utf8')

    const cli = await import('./index.ts')
    await cli.runNodeInit(cli.parseArgs(['node', 'init']))

    const nodeConfig = JSON.parse(readFileSync(path.join(tempHome, '.aamp-cli', 'nodes', 'default.json'), 'utf8'))
    expect(nodeConfig.mailbox.email).toBe('cached@meshmail.ai')
    expect(registerMailbox).not.toHaveBeenCalled()
  })

  it('node init can auto-register a mailbox when no cache exists', async () => {
    registerMailbox.mockResolvedValue({
      email: 'newly-registered@meshmail.ai',
      smtpPassword: 'smtp-new',
      mailboxToken: 'mailbox-token',
      baseUrl: 'https://meshmail.ai',
    })
    promptAnswers = ['yes', 'https://meshmail.ai', 'local-worker']

    const cli = await import('./index.ts')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await cli.runNodeInit(cli.parseArgs(['node', 'init']))

    expect(registerMailbox).toHaveBeenCalledWith(expect.objectContaining({
      aampHost: 'https://meshmail.ai',
      slug: 'local-worker',
    }))
    const nodeConfig = JSON.parse(readFileSync(path.join(tempHome, '.aamp-cli', 'nodes', 'default.json'), 'utf8'))
    expect(nodeConfig.mailbox.email).toBe('newly-registered@meshmail.ai')
    const cachedProfile = JSON.parse(readFileSync(path.join(tempHome, '.aamp-cli', 'profiles', 'default.json'), 'utf8'))
    expect(cachedProfile.email).toBe('newly-registered@meshmail.ai')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Registered new mailbox newly-registered@meshmail.ai'))
  })

  it('node command add can build and persist a command interactively', async () => {
    const nodeConfigPath = path.join(tempHome, '.aamp-cli', 'nodes', 'default.json')
    await mkdir(path.dirname(nodeConfigPath), { recursive: true })
    await writeFile(nodeConfigPath, JSON.stringify({
      version: 1,
      mailbox: {
        email: 'cached@meshmail.ai',
        smtpPassword: 'cached-smtp',
        baseUrl: 'https://meshmail.ai',
        smtpHost: 'meshmail.ai',
        smtpPort: 587,
        rejectUnauthorized: true,
      },
      commands: [],
      senderPolicy: {
        defaultAction: 'deny',
        allowFrom: [],
        allowCommands: [],
        requireContext: {},
      },
    }), 'utf8')

    const fakeBinDir = mkdtempSync(path.join(os.tmpdir(), 'aamp-cli-bin-'))
    const fakeGit = path.join(fakeBinDir, 'git')
    await writeFile(fakeGit, '#!/bin/sh\nexit 0\n', 'utf8')
    const previousPath = process.env.PATH
    process.env.PATH = `${fakeBinDir}${path.delimiter}${previousPath ?? ''}`

    promptAnswers = [
      'git apply [patch_file]',
      fakeGit,
      'git.apply',
      'Apply a patch file',
      '/tmp/workspace',
      '30000',
      '65536',
      '65536',
      'file',
      '2097152',
      'application/octet-stream,text/plain',
      'yes',
    ]

    const cli = await import('./index.ts')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await cli.runNodeCommandAdd(cli.parseArgs(['node', 'command', 'add']))

    const nodeConfig = JSON.parse(readFileSync(nodeConfigPath, 'utf8'))
    expect(nodeConfig.commands).toHaveLength(1)
    expect(nodeConfig.commands[0]).toMatchObject({
      name: 'git.apply',
      exec: fakeGit,
      argsTemplate: ['apply', '{{inputs.patch_file.path}}'],
      workingDirectory: '/tmp/workspace',
    })
    expect(nodeConfig.commands[0].attachments.patch_file).toMatchObject({
      required: true,
      maxBytes: 2097152,
    })

    const specPath = path.join(tempHome, '.aamp-cli', 'nodes', 'default.commands', 'git.apply.json')
    const savedSpec = JSON.parse(readFileSync(specPath, 'utf8'))
    expect(savedSpec.name).toBe('git.apply')
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Saved command spec'))

    process.env.PATH = previousPath
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

  it('parses equals-style flags and sends registered-command calls through the SDK client', async () => {
    const nodeConfigPath = path.join(tempHome, '.aamp-cli', 'nodes', 'default.json')
    await mkdir(path.dirname(nodeConfigPath), { recursive: true })
    await writeFile(nodeConfigPath, JSON.stringify({
      version: 1,
      mailbox: {
        email: 'caller@meshmail.ai',
        smtpPassword: 'caller-smtp',
        baseUrl: 'https://meshmail.ai',
        smtpHost: 'meshmail.ai',
        smtpPort: 587,
        rejectUnauthorized: true,
      },
      commands: [],
      senderPolicy: {
        defaultAction: 'deny',
        allowFrom: [],
        allowCommands: [],
        requireContext: {},
      },
    }), 'utf8')

    const patchFile = path.join(tempHome, 'fix.diff')
    await writeFile(patchFile, 'diff --git a/file b/file\n', 'utf8')

    const cli = await import('./index.ts')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await cli.runNodeCall(cli.parseArgs([
      'node',
      'call',
      '--target=worker@meshmail.ai',
      '--command=git.apply',
      '--stream=status-only',
      '--mode=check',
      `--patch_file=${patchFile}`,
      '--dispatch-context=project_key=proj-1',
    ]))

    const client = fromMailboxIdentity.mock.results[0].value as FakeClient
    expect(client.sendRegisteredCommand).toHaveBeenCalledWith(expect.objectContaining({
      to: 'worker@meshmail.ai',
      command: 'git.apply',
      streamMode: 'status-only',
      dispatchContext: { project_key: 'proj-1' },
      args: { mode: 'check' },
      inputs: [{ slot: 'patch_file', attachmentName: 'fix.diff' }],
    }))
    expect(client.sendRegisteredCommand.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({
        filename: 'fix.diff',
        contentType: 'text/x-diff',
      }),
    ])
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command": "git.apply"'))
  })

  it('infers application/zip for zip attachments in node call', async () => {
    const nodeConfigPath = path.join(tempHome, '.aamp-cli', 'nodes', 'default.json')
    await mkdir(path.dirname(nodeConfigPath), { recursive: true })
    await writeFile(nodeConfigPath, JSON.stringify({
      version: 1,
      mailbox: {
        email: 'caller@meshmail.ai',
        smtpPassword: 'caller-smtp',
        baseUrl: 'https://meshmail.ai',
        smtpHost: 'meshmail.ai',
        smtpPort: 587,
        rejectUnauthorized: true,
      },
      commands: [],
      senderPolicy: {
        defaultAction: 'deny',
        allowFrom: [],
        allowCommands: [],
        requireContext: {},
      },
    }), 'utf8')

    const zipFile = path.join(tempHome, 'bundle-errorcode.zip')
    await writeFile(zipFile, 'fake zip bytes', 'utf8')

    const cli = await import('./index.ts')

    await cli.runNodeCall(cli.parseArgs([
      'node',
      'call',
      '--target=worker@meshmail.ai',
      '--command=update_bundle',
      `--artifact_bundle=${zipFile}`,
    ]))

    const client = fromMailboxIdentity.mock.results[0].value as FakeClient
    expect(client.sendRegisteredCommand.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({
        filename: 'bundle-errorcode.zip',
        contentType: 'application/zip',
      }),
    ])
  })

  it('infers application/gzip for tar.gz attachments in node call', async () => {
    const nodeConfigPath = path.join(tempHome, '.aamp-cli', 'nodes', 'default.json')
    await mkdir(path.dirname(nodeConfigPath), { recursive: true })
    await writeFile(nodeConfigPath, JSON.stringify({
      version: 1,
      mailbox: {
        email: 'caller@meshmail.ai',
        smtpPassword: 'caller-smtp',
        baseUrl: 'https://meshmail.ai',
        smtpHost: 'meshmail.ai',
        smtpPort: 587,
        rejectUnauthorized: true,
      },
      commands: [],
      senderPolicy: {
        defaultAction: 'deny',
        allowFrom: [],
        allowCommands: [],
        requireContext: {},
      },
    }), 'utf8')

    const tgzFile = path.join(tempHome, 'artifact-bundle.tar.gz')
    await writeFile(tgzFile, 'fake tgz bytes', 'utf8')

    const cli = await import('./index.ts')

    await cli.runNodeCall(cli.parseArgs([
      'node',
      'call',
      '--target=worker@meshmail.ai',
      '--command=update_bundle',
      `--artifact_bundle=${tgzFile}`,
    ]))

    const client = fromMailboxIdentity.mock.results[0].value as FakeClient
    expect(client.sendRegisteredCommand.mock.calls[0][0].attachments).toEqual([
      expect.objectContaining({
        filename: 'artifact-bundle.tar.gz',
        contentType: 'application/gzip',
      }),
    ])
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
