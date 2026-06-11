import {
  AampClient,
  type AampAttachment,
  type AampThreadEvent,
  type PairRequest,
  type StructuredResultField,
  type TaskCancel,
  type TaskDispatch,
} from 'aamp-sdk'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { AgentConfig, BridgeConfig } from './config.js'
import { CliAgentClient } from './cli-agent-client.js'
import { resolveCliProfile } from './cli-profiles.js'
import { buildPrompt, parseResponse, type ResultAttachmentRef } from './prompt-builder.js'
import { getBridgeHomeDir, resolveCredentialsFile } from './storage.js'
import {
  addSenderPolicy,
  consumePairingCode,
  loadSenderPolicies,
  resolvePairingFile,
  resolveSenderPoliciesFile,
  rulesMatch,
  validatePairingCode,
  type SenderPolicy,
} from './pairing.js'
import type { ParsedCliStreamUpdate } from './stream-parser.js'

export interface AgentIdentity {
  email: string
  mailboxToken: string
  smtpPassword: string
}

function matchSenderPolicy(
  task: TaskDispatch,
  senderPolicies: AgentConfig['senderPolicies'],
): { allowed: boolean; reason?: string } {
  if (!senderPolicies?.length) return { allowed: false, reason: 'no configured senderPolicies' }

  const sender = task.from.toLowerCase()
  const policy = senderPolicies.find((item) => item.sender.trim().toLowerCase() === sender)
  if (!policy) {
    return { allowed: false, reason: `sender ${task.from} is not allowed by senderPolicies` }
  }

  const rules = policy.dispatchContextRules
  if (!rules || Object.keys(rules).length === 0) {
    return { allowed: true }
  }

  const context = task.dispatchContext ?? {}
  for (const [key, allowedValues] of Object.entries(rules)) {
    const contextValue = context[key]
    if (!contextValue) {
      return { allowed: false, reason: `dispatchContext missing required key "${key}"` }
    }
    if (!allowedValues.includes(contextValue)) {
      return { allowed: false, reason: `dispatchContext ${key}=${contextValue} is not allowed` }
    }
  }

  return { allowed: true }
}

function matchPairedSenderPolicy(
  task: TaskDispatch,
  senderPolicies: SenderPolicy[],
): { allowed: boolean; reason?: string } {
  if (senderPolicies.length === 0) return { allowed: false, reason: 'no paired sender policies configured' }

  const sender = task.from.toLowerCase()
  const policy = senderPolicies.find((item) => item.sender.trim().toLowerCase() === sender)
  if (!policy) {
    return { allowed: false, reason: `sender ${task.from} is not paired` }
  }

  if (!rulesMatch(policy.dispatchContextRules ?? {}, task.dispatchContext)) {
    return { allowed: false, reason: `dispatchContext does not match paired sender policy for ${task.from}` }
  }

  return { allowed: true }
}

function matchCombinedSenderPolicy(
  task: TaskDispatch,
  configuredPolicies: AgentConfig['senderPolicies'],
  pairedPolicies: SenderPolicy[],
): { allowed: boolean; reason?: string } {
  const hasConfiguredPolicies = (configuredPolicies?.length ?? 0) > 0
  const hasPairedPolicies = pairedPolicies.length > 0
  if (!hasConfiguredPolicies && !hasPairedPolicies) {
    return { allowed: false, reason: 'no sender policy configured' }
  }

  const configuredDecision = hasConfiguredPolicies
    ? matchSenderPolicy(task, configuredPolicies)
    : { allowed: false, reason: 'no configured senderPolicies' }
  const pairedDecision = hasPairedPolicies
    ? matchPairedSenderPolicy(task, pairedPolicies)
    : { allowed: false, reason: 'no paired sender policies configured' }
  if (pairedDecision.allowed) return pairedDecision
  if (configuredDecision.allowed) return configuredDecision
  return configuredDecision.reason ? configuredDecision : pairedDecision
}

export interface AgentBridgeStartOptions {
  quiet?: boolean
}

interface HandleEventOptions {
  historical?: boolean
}

function threadAlreadyTerminal(events: AampThreadEvent[] | undefined): boolean {
  return (events ?? []).some((event) =>
    event.intent === 'task.result' || event.intent === 'task.cancel',
  )
}

function threadAlreadyPairResponded(events: AampThreadEvent[] | undefined): boolean {
  return (events ?? []).some((event) => event.intent === 'pair.respond')
}

function sanitizeAttachmentFilename(value: string | undefined, path: string): string {
  const fallback = basename(path).replace(/[\r\n]/g, ' ').trim()
  const fromValue = value?.replace(/[\r\n]/g, ' ').trim()
  if (!fromValue) return fallback
  return basename(fromValue) || fallback
}

function sanitizeContentType(value: string | undefined): string {
  const normalized = value?.replace(/[\r\n]/g, '').trim()
  return normalized || 'application/octet-stream'
}

function mergeAttachmentRefs(files: string[], attachmentRefs?: ResultAttachmentRef[]): ResultAttachmentRef[] {
  const byKey = new Map<string, ResultAttachmentRef>()

  for (const file of files) {
    byKey.set(file, { path: file })
  }

  for (const attachment of attachmentRefs ?? []) {
    byKey.set(attachment.path, attachment)
  }

  return [...byKey.values()]
}

function isAttachmentStructuredField(field: { fieldTypeKey?: string }): boolean {
  return /(attachment|file)/i.test(field.fieldTypeKey ?? '')
}

function fillStructuredResultAttachmentFilenames(
  structuredResult: StructuredResultField[] | undefined,
  attachments: AampAttachment[],
): StructuredResultField[] | undefined {
  if (!structuredResult?.length || !attachments.length) return structuredResult
  const filenames = attachments.map((attachment) => attachment.filename)
  return structuredResult.map((field) => {
    if (!isAttachmentStructuredField(field) || field.attachmentFilenames?.length) return field
    return {
      ...field,
      attachmentFilenames: filenames,
    }
  })
}

function isThreadNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('Thread history fetch failed: 404')
    || message.includes('"Task not found"')
}

function formatLogTime(date = new Date()): string {
  return date.toISOString()
}

function formatElapsed(startedAt: Date | null): string {
  if (!startedAt) return 'n/a'
  return `${((Date.now() - startedAt.getTime()) / 1_000).toFixed(3)}s`
}

function stringifyStreamPayload(payload: Record<string, unknown>): string {
  if (typeof payload.text === 'string') return payload.text
  if (typeof payload.chunk === 'string') return payload.chunk
  return JSON.stringify(payload, null, 2)
}

function taskLockName(taskId: string): string {
  return taskId
    .trim()
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 128) || 'task'
}

function acquireTaskExecutionLock(taskId: string): string | null {
  const locksDir = join(getBridgeHomeDir(), 'task-locks')
  const lockDir = join(locksDir, `${taskLockName(taskId)}.lock`)
  mkdirSync(locksDir, { recursive: true })
  try {
    mkdirSync(lockDir)
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      taskId,
      acquiredAt: new Date().toISOString(),
    }, null, 2)}\n`)
    return lockDir
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return null
    throw error
  }
}

function releaseTaskExecutionLock(lockDir: string | null): void {
  if (!lockDir) return
  rmSync(lockDir, { recursive: true, force: true })
}

export class AgentBridge {
  private client: AampClient | null = null
  private identity: AgentIdentity | null = null
  private cli: CliAgentClient
  private activeTaskCount = 0
  private pollingFallback = false
  private cancelledTaskIds = new Set<string>()
  private activeTaskIds = new Set<string>()
  private profileLabel: string
  private streamEnabled: boolean
  private senderPolicies: SenderPolicy[] = []
  private isHistoricalReconcile = false

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly aampHost: string,
    private readonly rejectUnauthorized: boolean,
    customProfiles?: BridgeConfig['profiles'],
  ) {
    const profile = resolveCliProfile(agentConfig.cliProfile, customProfiles)
    this.profileLabel = profile.name ?? (typeof agentConfig.cliProfile === 'string' ? agentConfig.cliProfile : 'inline')
    this.streamEnabled = profile.stream?.enabled !== false && Boolean(profile.stream)
    this.cli = new CliAgentClient(profile, agentConfig.name)
  }

  get name(): string { return this.agentConfig.name }
  get email(): string { return this.identity?.email ?? '(not registered)' }
  get isConnected(): boolean { return this.client?.isConnected() ?? false }
  get isUsingPollingFallback(): boolean { return this.pollingFallback || (this.client?.isUsingPollingFallback() ?? false) }
  get isBusy(): boolean { return this.activeTaskCount > 0 }

  private getConfiguredCardText(): string | undefined {
    const inline = this.agentConfig.cardText?.trim()
    if (inline) return inline

    const file = this.agentConfig.cardFile?.trim()
    if (!file) return undefined

    const fromFile = readFileSync(file, 'utf-8').trim()
    return fromFile || undefined
  }

  private async syncDirectoryProfile(options: { quiet?: boolean } = {}): Promise<void> {
    if (!this.client) return

    const summary = this.agentConfig.summary?.trim() || this.agentConfig.description?.trim()
    const cardText = this.getConfiguredCardText()

    if (!summary && !cardText) return

    await this.client.updateDirectoryProfile({
      ...(summary ? { summary } : {}),
      ...(cardText ? { cardText } : {}),
    })

    if (!options.quiet) {
      console.log(
        `[${this.name}] Directory profile synced${cardText ? ' (card text registered)' : ''}`,
      )
    }
  }

  async start(options: AgentBridgeStartOptions = {}): Promise<void> {
    let quietStartup = options.quiet === true
    this.identity = await this.resolveIdentity()
    this.senderPolicies = loadSenderPolicies(resolveSenderPoliciesFile(
      this.agentConfig.senderPoliciesFile,
      this.agentConfig.name,
    ))
    if (!quietStartup) {
      console.log(`[${this.name}] AAMP identity: ${this.identity.email}`)
      console.log(`[${this.name}] CLI profile: ${this.profileLabel}`)
    }

    this.client = AampClient.fromMailboxIdentity({
      email: this.identity.email,
      smtpPassword: this.identity.smtpPassword,
      baseUrl: this.aampHost,
      rejectUnauthorized: this.rejectUnauthorized,
    })
    const client = this.client

    client.on('task.dispatch', (task: TaskDispatch) => {
      const historical = this.isHistoricalReconcile
      return this.handleTask(task, { historical }).catch((err) => {
        console.error(`[${this.name}] Task ${task.taskId} failed: ${(err as Error).message}`)
      })
    })

    client.on('task.cancel', (task: TaskCancel) => {
      this.cancelledTaskIds.add(task.taskId)
      console.warn(`[${this.name}] <- task.cancel  ${task.taskId}  from=${task.from}`)
    })

    ;(client as unknown as {
      on(event: 'pair.request', handler: (request: PairRequest) => void): void
    }).on('pair.request', (request) => {
      const historical = this.isHistoricalReconcile
      void this.handlePairRequest(request, { historical }).catch((err) => {
        console.warn(`[${this.name}] Failed to handle pair.request: ${(err as Error).message}`)
      })
    })

    client.on('connected', () => {
      this.pollingFallback = client.isUsingPollingFallback()
      if (!quietStartup) {
        console.log(`[${this.name}] AAMP connected${this.pollingFallback ? ' (polling fallback)' : ''}`)
      }
    })

    client.on('disconnected', (reason: string) => {
      this.pollingFallback = client.isUsingPollingFallback()
      if (!quietStartup) {
        console.warn(`[${this.name}] AAMP disconnected: ${reason}`)
      }
    })

    client.on('error', (err: Error) => {
      if (err.message.includes('falling back to polling')) {
        this.pollingFallback = true
        if (!quietStartup) {
          console.warn(`[${this.name}] ${err.message}`)
        }
        return
      }
      console.error(`[${this.name}] AAMP error: ${err.message}`)
    })

    await client.connect()
    this.isHistoricalReconcile = true
    const reconciled = await client.reconcileRecentEmails(50, { includeHistorical: true })
      .catch((err) => {
        if (!quietStartup) {
          console.warn(`[${this.name}] Recent email reconcile failed: ${(err as Error).message}`)
        }
        return 0
      })
      .finally(() => {
        this.isHistoricalReconcile = false
      })
    if (!quietStartup) {
      console.log(`[${this.name}] Reconciled ${reconciled} recent email(s)`)
    }
    await this.syncDirectoryProfile({ quiet: quietStartup }).catch((err) => {
      if (!quietStartup) {
        console.warn(`[${this.name}] Directory profile sync failed: ${(err as Error).message}`)
      }
    })
    quietStartup = false
  }

  stop(): void {
    this.client?.disconnect()
    this.client = null
  }

  private async handleTask(task: TaskDispatch, options: HandleEventOptions = {}): Promise<void> {
    if (!this.client) return

    const shouldLogTask = !options.historical
    if (shouldLogTask) {
      console.log(`[${this.name}] <- task.dispatch  ${task.taskId}  "${task.title}"  from=${task.from}`)
    }

    if (task.expiresAt && new Date(task.expiresAt).getTime() <= Date.now()) {
      console.warn(`[${this.name}] Skipping expired task ${task.taskId}`)
      return
    }

    if (this.cancelledTaskIds.has(task.taskId)) {
      console.warn(`[${this.name}] Ignoring cancelled task ${task.taskId}`)
      return
    }

    if (this.activeTaskIds.has(task.taskId)) {
      console.warn(`[${this.name}] Ignoring duplicate active task ${task.taskId}`)
      return
    }

    const hydratedTask = await this.client.hydrateTaskDispatch(task).catch((err) => {
      if (!options.historical) {
        console.warn(`[${this.name}] Failed to load thread history for ${task.taskId}: ${(err as Error).message}`)
      }
      if (options.historical) return null
      return {
        ...task,
        threadHistory: [],
        threadContextText: '',
      }
    })

    if (!hydratedTask) {
      return
    }

    if (threadAlreadyTerminal(hydratedTask.threadHistory)) {
      if (shouldLogTask) {
        console.log(`[${this.name}] Skipping task ${task.taskId} because the thread already reached a terminal state`)
      }
      return
    }

    const senderDecision = matchCombinedSenderPolicy(task, this.agentConfig.senderPolicies, this.senderPolicies)
    if (!senderDecision.allowed) {
      if (options.historical) return
      console.warn(`[${this.name}] Rejecting task ${task.taskId}: ${senderDecision.reason ?? 'sender policy rejected the task'}`)
      await this.client.sendResult({
        to: task.from,
        taskId: task.taskId,
        status: 'rejected',
        output: '',
        errorMsg: `Unauthorized sender policy: ${senderDecision.reason ?? 'task does not match senderPolicies.'}`,
        inReplyTo: task.messageId,
      })
      return
    }

    const taskLockDir = acquireTaskExecutionLock(task.taskId)
    if (!taskLockDir) {
      console.warn(`[${this.name}] Ignoring duplicate locked task ${task.taskId}`)
      return
    }

    this.activeTaskIds.add(task.taskId)
    this.activeTaskCount += 1
    let activeStream: Awaited<ReturnType<AampClient['createStream']>> | null = null
    let streamOpenedAt: Date | null = null
    const pendingStreamWrites = new Set<Promise<void>>()

    const queueStreamAppend = (
      type: 'text.delta' | 'progress' | 'status' | 'error' | 'done',
      payload: Record<string, unknown>,
    ) => {
      if (!this.client || !activeStream) return
      const streamId = activeStream.streamId
      console.log(
        `[${this.name}] ~~ stream.event  ${task.taskId}  stream=${streamId}  type=${type}  at=${formatLogTime()}  elapsed=${formatElapsed(streamOpenedAt)}`,
      )
      console.log(stringifyStreamPayload(payload))
      let write: Promise<void>
      write = this.client.appendStreamEvent({
        streamId,
        type,
        payload,
      })
        .then(() => undefined)
        .catch((err) => {
          console.warn(`[${this.name}] Failed to append ${type} stream event for ${task.taskId}: ${(err as Error).message}`)
        })
        .finally(() => {
          pendingStreamWrites.delete(write)
        })
      pendingStreamWrites.add(write)
    }

    const flushStreamWrites = async () => {
      while (pendingStreamWrites.size > 0) {
        await Promise.allSettled([...pendingStreamWrites])
      }
    }

    const handleStreamUpdate = (update: ParsedCliStreamUpdate) => {
      const eventType = update.event.type
      const data = update.event.data

      if (update.textDelta) {
        queueStreamAppend('text.delta', {
          text: update.textDelta,
          channel: 'assistant',
          sourceEvent: eventType,
        })
        return
      }

      if (update.finalText) {
        queueStreamAppend('text.delta', {
          text: update.finalText,
          channel: 'assistant',
          sourceEvent: eventType,
        })
        return
      }

      if (eventType === 'session') {
        queueStreamAppend('status', {
          state: 'running',
          label: 'CLI session started',
          data,
        })
        return
      }

      if (eventType === 'tool_start' || eventType === 'tool_call') {
        const record = data && typeof data === 'object' && !Array.isArray(data)
          ? data as Record<string, unknown>
          : {}
        queueStreamAppend('progress', {
          label: `Tool running: ${typeof record.name === 'string' ? record.name : 'tool'}`,
          status: 'in_progress',
          ...record,
        })
        return
      }

      if (eventType === 'tool_result' || eventType === 'tool_call_update') {
        const record = data && typeof data === 'object' && !Array.isArray(data)
          ? data as Record<string, unknown>
          : {}
        const failed = record.is_error === true || record.status === 'failed'
        queueStreamAppend('progress', {
          label: `Tool ${failed ? 'failed' : 'completed'}: ${typeof record.name === 'string' ? record.name : 'tool'}`,
          status: failed ? 'failed' : 'completed',
          ...record,
        })
        return
      }

      if (eventType === 'tool_partial_output') {
        const record = data && typeof data === 'object' && !Array.isArray(data)
          ? data as Record<string, unknown>
          : {}
        const chunk = typeof record.chunk === 'string' ? record.chunk : undefined
        queueStreamAppend('progress', {
          label: 'Tool output',
          status: 'in_progress',
          ...record,
          ...(chunk ? { chunk } : {}),
        })
        return
      }

      if (eventType === 'usage') {
        queueStreamAppend('progress', {
          label: 'Token usage updated',
          ...(
            data && typeof data === 'object' && !Array.isArray(data)
              ? data as Record<string, unknown>
              : { data }
          ),
        })
        return
      }

      if (eventType === 'done') {
        queueStreamAppend('status', {
          state: 'running',
          label: 'CLI stream completed',
          data,
        })
      }
    }

    try {
      if (this.streamEnabled) {
        try {
          activeStream = await this.client.createStream({
            taskId: task.taskId,
            peerEmail: task.from,
          })
          streamOpenedAt = new Date()
          console.log(
            `[${this.name}] ~~ stream.open  ${task.taskId}  stream=${activeStream.streamId}  at=${formatLogTime(streamOpenedAt)}`,
          )
          await this.client.sendStreamOpened({
            to: task.from,
            taskId: task.taskId,
            streamId: activeStream.streamId,
            inReplyTo: task.messageId,
          })
          queueStreamAppend('status', { state: 'running', label: 'CLI task started' })
        } catch (err) {
          activeStream = null
          streamOpenedAt = null
          console.warn(`[${this.name}] AAMP stream unavailable for ${task.taskId}: ${(err as Error).message}`)
        }
      }

      const prompt = buildPrompt(hydratedTask, hydratedTask.threadContextText, this.name)
      const result = await this.cli.prompt(hydratedTask.sessionKey, prompt, {
        onStreamUpdate: handleStreamUpdate,
      })
      if (this.cancelledTaskIds.has(task.taskId)) {
        console.warn(`[${this.name}] Dropping task ${task.taskId} result because the task was cancelled`)
        return
      }
      await flushStreamWrites()

      const parsed = parseResponse(result.output)
      if (!parsed.isHelp
        && !parsed.output
        && parsed.files.length === 0
        && !parsed.structuredResult?.length
        && !parsed.attachments?.length) {
        throw new Error('CLI agent completed without a final response')
      }
      if (parsed.isHelp) {
        if (activeStream) {
          console.log(
            `[${this.name}] ~~ stream.close ${task.taskId}  stream=${activeStream.streamId}  reason=task.help_needed  at=${formatLogTime()}  elapsed=${formatElapsed(streamOpenedAt)}`,
          )
          await this.client.closeStream({
            streamId: activeStream.streamId,
            payload: { reason: 'task.help_needed' },
          })
        }
        await this.client.sendHelp({
          to: task.from,
          taskId: task.taskId,
          question: parsed.question ?? 'Agent needs more information',
          blockedReason: 'CLI agent requested clarification',
          suggestedOptions: [],
          inReplyTo: task.messageId,
        })
        console.log(`[${this.name}] -> task.help_needed  ${task.taskId}`)
        return
      }

      const attachments: AampAttachment[] = []
      for (const attachmentRef of mergeAttachmentRefs(parsed.files, parsed.attachments)) {
        const filepath = attachmentRef.path
        if (!existsSync(filepath)) {
          console.warn(`[${this.name}] Attachment file not found: ${filepath}`)
          continue
        }
        try {
          attachments.push({
            filename: sanitizeAttachmentFilename(attachmentRef.filename, filepath),
            contentType: sanitizeContentType(attachmentRef.contentType),
            content: readFileSync(filepath),
          })
          console.log(`[${this.name}] Attaching file: ${filepath}`)
        } catch (err) {
          console.warn(`[${this.name}] Failed to read file ${filepath}: ${(err as Error).message}`)
        }
      }
      const structuredResult = fillStructuredResultAttachmentFilenames(
        parsed.structuredResult,
        attachments,
      )

      if (activeStream) {
        console.log(
          `[${this.name}] ~~ stream.close ${task.taskId}  stream=${activeStream.streamId}  reason=task.result  at=${formatLogTime()}  elapsed=${formatElapsed(streamOpenedAt)}`,
        )
        await this.client.closeStream({
          streamId: activeStream.streamId,
          payload: { reason: 'task.result', status: 'completed' },
        })
      }
      console.log(`[${this.name}] -> task.result.output ${task.taskId}\n${parsed.output}`)
      await this.client.sendResult({
        to: task.from,
        taskId: task.taskId,
        status: 'completed',
        output: parsed.output,
        structuredResult,
        inReplyTo: task.messageId,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
      console.log(`[${this.name}] -> task.result  ${task.taskId}  completed${structuredResult?.length ? ` (${structuredResult.length} structured field(s))` : ''}${attachments.length ? ` (${attachments.length} attachment(s))` : ''}`)
    } catch (err) {
      const errorMsg = (err as Error).message
      console.error(`[${this.name}] Task ${task.taskId} error: ${errorMsg}`)
      try {
        await flushStreamWrites()
        if (activeStream) {
          console.log(
            `[${this.name}] ~~ stream.close ${task.taskId}  stream=${activeStream.streamId}  reason=task.result  status=rejected  at=${formatLogTime()}  elapsed=${formatElapsed(streamOpenedAt)}`,
          )
          await this.client.closeStream({
            streamId: activeStream.streamId,
            payload: { reason: 'task.result', status: 'rejected', error: errorMsg },
          })
        }
      } catch { /* best effort */ }
      console.log(`[${this.name}] -> task.result.output ${task.taskId}\nCLI agent error: ${errorMsg}`)
      await this.client.sendResult({
        to: task.from,
        taskId: task.taskId,
        status: 'rejected',
        output: '',
        errorMsg: `CLI agent error: ${errorMsg}`,
        inReplyTo: task.messageId,
      }).catch(() => {})
    } finally {
      this.activeTaskCount = Math.max(0, this.activeTaskCount - 1)
      this.activeTaskIds.delete(task.taskId)
      releaseTaskExecutionLock(taskLockDir)
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase()
  }

  private async sendPairResponse(request: PairRequest, success: boolean, reason?: string): Promise<boolean> {
    if (!this.client) return false
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client.sendPairRespond({
          to: request.from,
          taskId: request.taskId,
          success,
          reason,
          inReplyTo: request.messageId,
        })
        return true
      } catch (err) {
        lastError = err
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
        }
      }
    }
    console.warn(`[${this.name}] Failed to send pair.respond to ${request.from}: ${(lastError as Error)?.message ?? String(lastError)}`)
    return false
  }

  private async handlePairRequest(request: PairRequest, options: HandleEventOptions = {}): Promise<void> {
    if (!this.identity || !this.client) return
    const shouldLogRequest = !options.historical
    if (shouldLogRequest) {
      console.log(`[${this.name}] <- pair.request  ${request.taskId}  from=${request.from}`)
    }
    const requestTo = this.normalizeEmail(request.to)
    if (requestTo && requestTo !== this.normalizeEmail(this.identity.email)) {
      console.warn(`[${this.name}] Ignoring pair.request ${request.taskId}: addressed to ${request.to}`)
      return
    }
    const history = await this.client.getThreadHistory(request.taskId).catch((err) => {
      if (isThreadNotFoundError(err) && options.historical) {
        return null
      }
      if (!isThreadNotFoundError(err)) {
        console.warn(`[${this.name}] Failed to load pair thread ${request.taskId}: ${(err as Error).message}`)
      }
      return { taskId: request.taskId, events: [] }
    })
    if (!history) return
    const priorEvents = history.events.filter((event) => event.messageId !== request.messageId)
    if (threadAlreadyPairResponded(priorEvents)) {
      if (shouldLogRequest) {
        console.log(`[${this.name}] Skipping pair.request ${request.taskId} because it already has pair.respond`)
      }
      return
    }

    const pairingFile = resolvePairingFile(this.agentConfig.pairingFile, this.agentConfig.name)
    const senderPoliciesFile = resolveSenderPoliciesFile(this.agentConfig.senderPoliciesFile, this.agentConfig.name)
    const pairParams = {
      file: pairingFile,
      mailbox: this.identity.email,
      pairCode: request.pairCode,
    }
    const validPairing = validatePairingCode(pairParams)

    if (!validPairing) {
      const reason = 'invalid or expired pair code'
      if (options.historical) {
        return
      }
      console.warn(`[${this.name}] Rejected pair.request from ${request.from}: ${reason}`)
      await this.sendPairResponse(request, false, reason)
      return
    }

    this.senderPolicies = addSenderPolicy(senderPoliciesFile, {
      sender: this.normalizeEmail(request.from),
      dispatchContextRules: request.dispatchContextRules ?? {},
      pairedAt: new Date().toISOString(),
    })
    console.log(`[${this.name}] Paired sender ${request.from}; sender policy saved to ${senderPoliciesFile}`)
    if (await this.sendPairResponse(request, true)) {
      consumePairingCode(pairParams)
    } else {
      console.warn(`[${this.name}] Pairing code left active so ${request.from} can retry before it expires`)
    }
  }

  private async resolveIdentity(): Promise<AgentIdentity> {
    const credFile = resolveCredentialsFile(this.agentConfig.credentialsFile, this.agentConfig.name)

    if (existsSync(credFile)) {
      try {
        const data = JSON.parse(readFileSync(credFile, 'utf-8'))
        if (data.email && data.mailboxToken && data.smtpPassword) {
          return {
            email: data.email,
            mailboxToken: data.mailboxToken,
            smtpPassword: data.smtpPassword,
          }
        }
      } catch { /* re-register */ }
    }

    const slug = this.agentConfig.slug ?? `${this.agentConfig.name}-cli-bridge`
    const description = this.agentConfig.description ?? `${this.agentConfig.name} via CLI bridge`
    const creds = await AampClient.registerMailbox({
      aampHost: this.aampHost,
      slug,
      description,
    })

    mkdirSync(dirname(credFile), { recursive: true })
    writeFileSync(credFile, JSON.stringify({
      email: creds.email,
      mailboxToken: creds.mailboxToken,
      smtpPassword: creds.smtpPassword,
    }, null, 2))

    return creds
  }
}
