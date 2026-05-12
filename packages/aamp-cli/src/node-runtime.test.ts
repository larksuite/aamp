import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AampLocalNodeService,
  parseRegisteredCommandPayload,
} from './node-runtime.js'
import type { NodeConfig } from './node-config.js'

class FakeClient extends EventEmitter {
  email = 'worker@meshmail.ai'
  connect = vi.fn().mockResolvedValue(undefined)
  disconnect = vi.fn()
  isUsingPollingFallback = vi.fn().mockReturnValue(false)
  reconcileRecentEmails = vi.fn().mockResolvedValue(0)
  createStream = vi.fn().mockResolvedValue({ streamId: 'stream-1' })
  sendStreamOpened = vi.fn().mockResolvedValue(undefined)
  appendStreamEvent = vi.fn().mockImplementation(async (opts) => ({
    id: 'evt-1',
    streamId: opts.streamId,
    taskId: 'task-1',
    seq: 1,
    timestamp: new Date().toISOString(),
    type: opts.type,
    payload: opts.payload,
  }))
  closeStream = vi.fn().mockResolvedValue(undefined)
  downloadBlob = vi.fn().mockResolvedValue(Buffer.from('patch-content'))
  getThreadHistory = vi.fn().mockResolvedValue({ taskId: 'task-1', events: [] })
  sendResult = vi.fn().mockResolvedValue(undefined)

  override on(event: string, handler: (...args: any[]) => void): this {
    return super.on(event, handler)
  }
}

function createNodeConfig(workdir: string): NodeConfig {
  return {
    version: 1,
    mailbox: {
      email: 'worker@meshmail.ai',
      smtpPassword: 'smtp-1',
      baseUrl: 'https://meshmail.ai',
      smtpPort: 587,
      rejectUnauthorized: true,
    },
    commands: [
      {
        name: 'demo.echo',
        exec: '/usr/bin/demo',
        argsTemplate: ['run', '{{args.value}}'],
        workingDirectory: workdir,
        argSchema: {
          type: 'object',
          required: ['value'],
          additionalProperties: false,
          properties: {
            value: { type: 'string' },
          },
        },
        timeoutMs: 10_000,
        maxStdoutBytes: 5,
        maxStderrBytes: 1024,
        environment: {
          DEMO_TOKEN: 'secret-value',
        },
      },
    ],
    senderPolicy: {
      defaultAction: 'allow',
      allowFrom: [],
      allowCommands: [],
      requireContext: {},
    },
  }
}

function createFakeSpawn(
  stdoutText: string,
  stderrText = '',
) {
  const calls: Array<{ cmd: string; argv: string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = []
  const fakeSpawn = vi.fn((cmd: string, argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    calls.push({ cmd, argv, cwd: opts.cwd, env: opts.env })
    const child = new EventEmitter() as any
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = vi.fn(() => true)

    queueMicrotask(() => {
      child.stdout.write(Buffer.from(stdoutText))
      child.stdout.end()
      if (stderrText) {
        child.stderr.write(Buffer.from(stderrText))
      }
      child.stderr.end()
      child.emit('close', 0)
    })

    return child
  })

  return { fakeSpawn, calls }
}

describe('node runtime', () => {
  let tempHome = ''

  beforeEach(() => {
    vi.restoreAllMocks()
    tempHome = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-test-'))
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses registered-command payloads from JSON bodies', () => {
    const payload = parseRegisteredCommandPayload(`
Dispatch metadata

{
  "kind": "registered-command/v1",
  "command": "demo.echo",
  "args": { "value": "hello" }
}
`)

    expect(payload.command).toBe('demo.echo')
    expect(payload.args).toEqual({ value: 'hello' })
  })

  it('executes a registered command, streams output, and attaches full stdout when truncated', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-workdir-'))
    const client = new FakeClient()
    const { fakeSpawn, calls } = createFakeSpawn('hello world')
    const service = new AampLocalNodeService('default', createNodeConfig(workdir), client as any, console, fakeSpawn as any)

    await service.start()

    client.emit('task.dispatch', {
      protocolVersion: '1.1',
      intent: 'task.dispatch',
      taskId: 'task-1',
      title: 'Run demo',
      priority: 'normal',
      from: 'dispatcher@meshmail.ai',
      to: 'worker@meshmail.ai',
      messageId: 'msg-1',
      subject: '[AAMP Task] Run demo',
      bodyText: JSON.stringify({
        kind: 'registered-command/v1',
        command: 'demo.echo',
        args: { value: 'hello' },
      }),
    })

    await vi.waitFor(() => expect(client.sendResult).toHaveBeenCalledTimes(1))

    expect(calls).toEqual([
      {
        cmd: '/usr/bin/demo',
        argv: ['run', 'hello'],
        cwd: workdir,
        env: expect.objectContaining({
          DEMO_TOKEN: 'secret-value',
        }),
      },
    ])

    const resultCall = client.sendResult.mock.calls[0]?.[0]
    expect(resultCall.status).toBe('completed')
    expect(resultCall.attachments).toHaveLength(1)

    const body = JSON.parse(String(resultCall.rawBodyText))
    expect(body.kind).toBe('registered-command-result/v1')
    expect(body.command).toBe('demo.echo')
    expect(body.truncated.stdout).toBe(true)
    expect(body.attachments).toEqual([
      {
        name: 'demo.echo-stdout.txt',
        contentType: 'text/plain',
      },
    ])

    const attachment = resultCall.attachments[0]
    expect(attachment.filename).toBe('demo.echo-stdout.txt')
    expect(Buffer.isBuffer(attachment.content)).toBe(true)
    expect(Buffer.from(attachment.content).toString('utf8')).toBe('hello world')

    expect(client.createStream).toHaveBeenCalledWith({
      taskId: 'task-1',
      peerEmail: 'dispatcher@meshmail.ai',
    })
    expect(client.sendStreamOpened).toHaveBeenCalled()
    expect(client.appendStreamEvent).toHaveBeenCalled()

    const ledgerFile = path.join(tempHome, '.aamp', 'cli', 'node-state', 'default', 'ledger.json')
    const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    expect(ledger.tasks['task-1'].status).toBe('completed')
  })

  it('lists environment variable names but not values in capability cards', async () => {
    const { buildNodeCapabilityCard } = await import('./node-runtime.js')
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-workdir-'))
    const card = buildNodeCapabilityCard(createNodeConfig(workdir))

    expect(card).toContain('Environment variables: DEMO_TOKEN')
    expect(card).not.toContain('secret-value')
  })

  it('rejects dispatches before execution when sender policy blocks them', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-workdir-'))
    const config = createNodeConfig(workdir)
    config.senderPolicy = {
      defaultAction: 'deny',
      allowFrom: [],
      allowCommands: [],
      requireContext: {},
    }
    const client = new FakeClient()
    const { fakeSpawn } = createFakeSpawn('should not run')
    const service = new AampLocalNodeService('default', config, client as any, console, fakeSpawn as any)

    await service.start()

    client.emit('task.dispatch', {
      protocolVersion: '1.1',
      intent: 'task.dispatch',
      taskId: 'task-2',
      title: 'Blocked',
      priority: 'normal',
      from: 'dispatcher@meshmail.ai',
      to: 'worker@meshmail.ai',
      messageId: 'msg-2',
      subject: '[AAMP Task] Blocked',
      bodyText: JSON.stringify({
        kind: 'registered-command/v1',
        command: 'demo.echo',
        args: { value: 'hello' },
      }),
    })

    await vi.waitFor(() => expect(client.sendResult).toHaveBeenCalledTimes(1))

    expect(fakeSpawn).not.toHaveBeenCalled()
    expect(client.sendResult.mock.calls[0]?.[0].status).toBe('rejected')
  })

  it('accepts common zip content type aliases for attachment slots', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-workdir-'))
    const config = createNodeConfig(workdir)
    config.commands = [
      {
        name: 'demo.zip',
        exec: '/usr/bin/demo',
        argsTemplate: ['apply', '{{inputs.archive.path}}'],
        workingDirectory: workdir,
        attachments: {
          archive: {
            required: true,
            contentTypes: ['application/zip'],
            maxBytes: 1024 * 1024,
          },
        },
      },
    ]
    const client = new FakeClient()
    const { fakeSpawn, calls } = createFakeSpawn('zip ok')
    const service = new AampLocalNodeService('default', config, client as any, console, fakeSpawn as any)

    await service.start()

    client.emit('task.dispatch', {
      protocolVersion: '1.1',
      intent: 'task.dispatch',
      taskId: 'task-zip',
      title: 'Run zip demo',
      priority: 'normal',
      from: 'dispatcher@meshmail.ai',
      to: 'worker@meshmail.ai',
      messageId: 'msg-zip',
      subject: '[AAMP Task] Run zip demo',
      attachments: [{
        filename: 'linco-errorcode.zip',
        contentType: 'application/x-zip-compressed',
        size: 128,
        blobId: 'blob-zip',
      }],
      bodyText: JSON.stringify({
        kind: 'registered-command/v1',
        command: 'demo.zip',
        inputs: [{ slot: 'archive', attachmentName: 'linco-errorcode.zip' }],
      }),
    })

    await vi.waitFor(() => expect(client.sendResult).toHaveBeenCalledTimes(1))

    expect(fakeSpawn).toHaveBeenCalledTimes(1)
    expect(calls[0]?.argv[0]).toBe('apply')
    expect(client.sendResult.mock.calls[0]?.[0].status).toBe('completed')
  })

  it('accepts common tar.gz content type aliases for attachment slots', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-workdir-'))
    const config = createNodeConfig(workdir)
    config.commands = [
      {
        name: 'demo.tgz',
        exec: '/usr/bin/demo',
        argsTemplate: ['apply', '{{inputs.archive.path}}'],
        workingDirectory: workdir,
        attachments: {
          archive: {
            required: true,
            contentTypes: ['application/gzip'],
            maxBytes: 1024 * 1024,
          },
        },
      },
    ]
    const client = new FakeClient()
    const { fakeSpawn, calls } = createFakeSpawn('tgz ok')
    const service = new AampLocalNodeService('default', config, client as any, console, fakeSpawn as any)

    await service.start()

    client.emit('task.dispatch', {
      protocolVersion: '1.1',
      intent: 'task.dispatch',
      taskId: 'task-tgz',
      title: 'Run tgz demo',
      priority: 'normal',
      from: 'dispatcher@meshmail.ai',
      to: 'worker@meshmail.ai',
      messageId: 'msg-tgz',
      subject: '[AAMP Task] Run tgz demo',
      attachments: [{
        filename: 'linco-bundle.tar.gz',
        contentType: 'application/x-compressed-tar',
        size: 128,
        blobId: 'blob-tgz',
      }],
      bodyText: JSON.stringify({
        kind: 'registered-command/v1',
        command: 'demo.tgz',
        inputs: [{ slot: 'archive', attachmentName: 'linco-bundle.tar.gz' }],
      }),
    })

    await vi.waitFor(() => expect(client.sendResult).toHaveBeenCalledTimes(1))

    expect(fakeSpawn).toHaveBeenCalledTimes(1)
    expect(calls[0]?.argv[0]).toBe('apply')
    expect(client.sendResult.mock.calls[0]?.[0].status).toBe('completed')
  })

  it('ignores self-sent historical dispatches from the same mailbox', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-workdir-'))
    const client = new FakeClient()
    const { fakeSpawn } = createFakeSpawn('should not run')
    const service = new AampLocalNodeService('default', createNodeConfig(workdir), client as any, console, fakeSpawn as any)

    await service.start()

    client.emit('task.dispatch', {
      protocolVersion: '1.1',
      intent: 'task.dispatch',
      taskId: 'task-self',
      title: 'Own sent task',
      priority: 'normal',
      from: 'worker@meshmail.ai',
      to: 'someone-else@meshmail.ai',
      messageId: 'msg-self',
      subject: '[AAMP Task] Own sent task',
      bodyText: JSON.stringify({
        kind: 'registered-command/v1',
        command: 'demo.echo',
        args: { value: 'hello' },
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fakeSpawn).not.toHaveBeenCalled()
    expect(client.sendResult).not.toHaveBeenCalled()
  })

  it('ignores expired historical dispatches before executing them', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-workdir-'))
    const client = new FakeClient()
    const { fakeSpawn } = createFakeSpawn('should not run')
    const service = new AampLocalNodeService('default', createNodeConfig(workdir), client as any, console, fakeSpawn as any)

    await service.start()

    client.emit('task.dispatch', {
      protocolVersion: '1.1',
      intent: 'task.dispatch',
      taskId: 'task-expired',
      title: 'Expired task',
      priority: 'normal',
      expiresAt: '2020-01-01T00:00:00.000Z',
      from: 'dispatcher@meshmail.ai',
      to: 'worker@meshmail.ai',
      messageId: 'msg-expired',
      subject: '[AAMP Task] Expired task',
      bodyText: JSON.stringify({
        kind: 'registered-command/v1',
        command: 'demo.echo',
        args: { value: 'hello' },
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fakeSpawn).not.toHaveBeenCalled()
    expect(client.sendResult).not.toHaveBeenCalled()

    const ledgerFile = path.join(tempHome, '.aamp', 'cli', 'node-state', 'default', 'ledger.json')
    await vi.waitFor(() => {
      const ledger = JSON.parse(readFileSync(ledgerFile, 'utf8'))
      expect(ledger.tasks['task-expired'].status).toBe('expired')
    })
  })

  it('ignores historical dispatches whose thread already has a terminal result', async () => {
    const workdir = mkdtempSync(path.join(os.tmpdir(), 'aamp-node-workdir-'))
    const client = new FakeClient()
    client.getThreadHistory.mockResolvedValue({
      taskId: 'task-old',
      events: [
        {
          intent: 'task.dispatch',
          from: 'dispatcher@meshmail.ai',
          to: 'worker@meshmail.ai',
          title: 'Old task',
          bodyText: 'dispatch body',
          createdAt: new Date().toISOString(),
        },
        {
          intent: 'task.result',
          from: 'worker@meshmail.ai',
          to: 'dispatcher@meshmail.ai',
          output: 'already done',
          createdAt: new Date().toISOString(),
        },
      ],
    })
    const { fakeSpawn } = createFakeSpawn('should not run')
    const service = new AampLocalNodeService('default', createNodeConfig(workdir), client as any, console, fakeSpawn as any)

    await service.start()

    client.emit('task.dispatch', {
      protocolVersion: '1.1',
      intent: 'task.dispatch',
      taskId: 'task-old',
      title: 'Old task',
      priority: 'normal',
      from: 'dispatcher@meshmail.ai',
      to: 'worker@meshmail.ai',
      messageId: 'msg-old',
      subject: '[AAMP Task] Old task',
      bodyText: JSON.stringify({
        kind: 'registered-command/v1',
        command: 'demo.echo',
        args: { value: 'hello' },
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fakeSpawn).not.toHaveBeenCalled()
    expect(client.sendResult).not.toHaveBeenCalled()
  })
})
