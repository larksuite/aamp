import {
  AampClient,
  type TaskDispatch,
  type AampAttachment,
  type StructuredResultField,
  type TaskCancel,
  type AampThreadEvent,
  type PairRequest,
} from 'aamp-sdk'
import {
  AcpxClient,
  type AcpPlanEntry,
  type AcpTextChunk,
  type AcpToolUpdate,
} from './acpx-client.js'
import { buildPrompt, parseResponse, type ResultAttachmentRef } from './prompt-builder.js'
import type { AgentConfig } from './config.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { resolveCredentialsFile } from './storage.js'
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
  const effectiveRules = Object.entries(rules)
    .map(([key, allowedValues]) => [
      key,
      (allowedValues ?? []).map((value) => value.trim()).filter(Boolean),
    ] as const)
    .filter(([, allowedValues]) => allowedValues.length > 0)

  if (effectiveRules.length === 0) {
    return { allowed: true }
  }

  for (const [key, allowedValues] of effectiveRules) {
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

  if (!rulesMatch(policy.dispatchContextRules, task.dispatchContext)) {
    return { allowed: false, reason: `dispatchContext does not match paired sender policy for ${task.from}` }
  }

  return { allowed: true }
}

function matchCombinedSenderPolicy(
  task: TaskDispatch,
  configuredPolicies: AgentConfig['senderPolicies'],
  pairedPolicies: SenderPolicy[],
): { allowed: boolean; reason?: string } {
  const hasConfiguredPolicies = Boolean(configuredPolicies?.length)
  const hasPairedPolicies = pairedPolicies.length > 0
  if (!hasConfiguredPolicies && !hasPairedPolicies) {
    return { allowed: false, reason: 'no sender policy configured' }
  }

  const configuredDecision = hasConfiguredPolicies
    ? matchSenderPolicy(task, configuredPolicies)
    : { allowed: false, reason: undefined }
  if (configuredDecision.allowed) return configuredDecision

  const pairedDecision = hasPairedPolicies
    ? matchPairedSenderPolicy(task, pairedPolicies)
    : { allowed: false, reason: undefined }
  if (pairedDecision.allowed) return pairedDecision

  return configuredDecision.reason ? configuredDecision : pairedDecision
}

export interface AgentBridgeStartOptions {
  quiet?: boolean
}

interface HandleEventOptions {
  historical?: boolean
}

interface StreamTextRenderState {
  currentChannel?: AcpTextChunk['channel']
  currentMessageId?: string
  hasContent: boolean
}

function buildPhaseStatusLabel(channel: AcpTextChunk['channel']): string {
  return channel === 'thought'
    ? 'ACP agent is thinking'
    : 'ACP agent is composing the reply'
}

function buildToolProgressLabel(update: AcpToolUpdate): string {
  const target = update.title?.trim()
    || update.locations?.[0]?.path
    || update.kind?.trim()
    || 'tool'

  switch (update.status) {
    case 'completed':
      return `Tool completed: ${target}`
    case 'failed':
      return `Tool failed: ${target}`
    case 'pending':
      return `Tool pending: ${target}`
    case 'in_progress':
    default:
      return `Tool running: ${target}`
  }
}

function formatPlanUpdate(entries: AcpPlanEntry[]): string {
  const lines = entries.map((entry) => {
    const prefix = entry.status ? `[${entry.status}] ` : ''
    return `- ${prefix}${entry.content}`
  })
  return `[plan]\n${lines.join('\n')}`
}

function renderTextChunk(chunk: AcpTextChunk, state: StreamTextRenderState): string {
  if (!chunk.text) return ''

  const sameMessage = Boolean(
    state.currentChannel === chunk.channel
    && (
      !chunk.messageId
      || !state.currentMessageId
      || chunk.messageId === state.currentMessageId
    ),
  )

  if (sameMessage) {
    return chunk.text
  }

  const prefix = state.hasContent ? '\n\n' : ''
  state.currentChannel = chunk.channel
  state.currentMessageId = chunk.messageId
  state.hasContent = true

  if (chunk.channel === 'thought') {
    return `${prefix}[thinking] ${chunk.text}`
  }

  const label = state.hasContent && prefix ? '[assistant] ' : ''
  return `${prefix}${label}${chunk.text}`
}

function threadAlreadyTerminal(events: AampThreadEvent[] | undefined): boolean {
  return (events ?? []).some((event) =>
    event.intent === 'task.result' || event.intent === 'task.cancel',
  )
}

function threadAlreadyPairResponded(events: AampThreadEvent[] | undefined): boolean {
  return (events ?? []).some((event) => event.intent === 'pair.respond')
}

function isThreadNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('Thread history fetch failed: 404')
    || message.includes('"Task not found"')
}

function isClosedStreamAppendError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('AAMP stream append failed: 409')
    && message.includes('Task stream is already closed')
}

function firstDispatchContextValue(
  context: Record<string, string> | undefined,
  keys: string[],
): string | undefined {
  if (!context) return undefined
  for (const key of keys) {
    const value = context[key]?.trim()
    if (value) return value
  }
  return undefined
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

/**
 * Bridges a single ACP agent to the AAMP network.
 * Manages AAMP identity, ACP session, and task routing.
 */
export class AgentBridge {
  private client: AampClient | null = null
  private acpx: AcpxClient
  private identity: AgentIdentity | null = null
  private sessionName: string
  private activeTaskCount = 0
  private pollingFallback = false
  private transportMode: 'connecting' | 'websocket' | 'polling' | 'disconnected' = 'connecting'
  private cancelledTaskIds = new Set<string>()
  private senderPolicies: SenderPolicy[] = []
  private activeTaskIds = new Set<string>()
  private isHistoricalReconcile = false

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly aampHost: string,
    private readonly rejectUnauthorized: boolean,
  ) {
    this.acpx = new AcpxClient()
    this.sessionName = `aamp-${agentConfig.name}`
  }

  get name(): string { return this.agentConfig.name }
  get email(): string { return this.identity?.email ?? '(not registered)' }
  get isConnected(): boolean { return this.client?.isConnected() ?? false }
  get isUsingPollingFallback(): boolean { return this.pollingFallback || (this.client?.isUsingPollingFallback() ?? false) }
  get isBusy(): boolean { return this.activeTaskCount > 0 }

  private sanitizeSessionSuffix(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9:_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 96)
  }

  private resolveTaskSessionName(task: TaskDispatch): string {
    const stickyValue = task.sessionKey?.trim()
    if (!stickyValue) return this.sessionName
    const suffix = this.sanitizeSessionSuffix(stickyValue)
    return suffix ? `${this.sessionName}-${suffix}` : this.sessionName
  }

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

  /**
   * Start the bridge: resolve identity → connect AAMP → ensure ACP session.
   */
  async start(options: AgentBridgeStartOptions = {}): Promise<void> {
    let quietStartup = options.quiet === true

    // 1. Resolve AAMP identity
    this.identity = await this.resolveIdentity()
    if (!quietStartup) {
      console.log(`[${this.name}] AAMP identity: ${this.identity.email}`)
    }

    // 2. Create AAMP client
    this.client = AampClient.fromMailboxIdentity({
      email: this.identity.email,
      smtpPassword: this.identity.smtpPassword,
      baseUrl: this.aampHost,
      rejectUnauthorized: this.rejectUnauthorized,
    })
    const client = this.client
    this.senderPolicies = loadSenderPolicies(
      resolveSenderPoliciesFile(this.agentConfig.senderPoliciesFile, this.agentConfig.name),
    )

    // 3. Wire up task handler
    client.on('task.dispatch', (task: TaskDispatch) => {
      const historical = this.isHistoricalReconcile
      return this.handleTask(task, { historical }).catch((err) => {
        console.error(`[${this.name}] Task ${task.taskId} failed: ${(err as Error).message}`)
      })
    })

    client.on('task.cancel', (task: TaskCancel) => {
      this.handleCancel(task)
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
      const usingPollingFallback = client.isUsingPollingFallback()
      this.pollingFallback = usingPollingFallback
      if (usingPollingFallback) {
        if (this.transportMode !== 'polling') {
          if (!quietStartup) {
            console.warn(`[${this.name}] AAMP connected (polling fallback active)`)
          }
        }
        this.transportMode = 'polling'
      } else {
        const previousMode = this.transportMode
        this.transportMode = 'websocket'
        if (quietStartup) {
          return
        }
        if (previousMode === 'polling') {
          console.log(`[${this.name}] AAMP WebSocket restored`)
        } else {
          console.log(`[${this.name}] AAMP connected`)
        }
      }
    })

    client.on('disconnected', (reason: string) => {
      const usingPollingFallback = client.isUsingPollingFallback()
      this.pollingFallback = usingPollingFallback
      if (usingPollingFallback) {
        if (this.transportMode !== 'polling') {
          if (!quietStartup) {
            console.warn(`[${this.name}] AAMP WebSocket unavailable, using polling fallback: ${reason}`)
          }
        }
        this.transportMode = 'polling'
      } else {
        this.transportMode = 'disconnected'
        console.warn(`[${this.name}] AAMP disconnected: ${reason}`)
      }
    })

    client.on('error', (err: Error) => {
      if (err.message.includes('falling back to polling')) {
        this.pollingFallback = true
        if (this.transportMode !== 'polling') {
          if (!quietStartup) {
            console.warn(`[${this.name}] ${err.message}`)
          }
          this.transportMode = 'polling'
        }
        return
      }
      if (this.transportMode === 'polling' && (
        err.message.includes('JMAP WebSocket handshake failed')
        || err.message.includes('Failed to get JMAP session')
        || err.message.includes('Polling fallback failed')
      )) {
        return
      }
      console.error(`[${this.name}] AAMP error: ${err.message}`)
    })

    // 4. Connect to AAMP
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

    // 5. Ensure ACP session
    try {
      await this.acpx.ensureSession(this.agentConfig.acpCommand, this.sessionName)
      if (!quietStartup) {
        console.log(`[${this.name}] ACP session ready: ${this.sessionName}`)
      }
    } catch (err) {
      if (!quietStartup) {
        console.warn(`[${this.name}] ACP session setup deferred: ${(err as Error).message}`)
      }
    }
    quietStartup = false
  }

  /**
   * Stop the bridge.
   */
  stop(): void {
    this.client?.disconnect()
    this.client = null
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase()
  }

  /**
   * Handle an incoming AAMP task by forwarding to the ACP agent.
   */
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

    const senderDecision = matchCombinedSenderPolicy(
      task,
      this.agentConfig.senderPolicies,
      this.senderPolicies,
    )
    if (!senderDecision.allowed) {
      if (options.historical) return
      console.warn(
        `[${this.name}] Rejecting task ${task.taskId}: ${senderDecision.reason ?? 'sender policy rejected the task'}`,
      )
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

    this.activeTaskIds.add(task.taskId)
    this.activeTaskCount += 1
    const taskSessionName = this.resolveTaskSessionName(hydratedTask)
    let activeStream: Awaited<ReturnType<AampClient['createStream']>> | null = null
    const pendingStreamWrites = new Set<Promise<void>>()
    let streamClosed = false
    const streamTextState: StreamTextRenderState = { hasContent: false }
    let currentPhase: AcpTextChunk['channel'] | null = null

    const queueStreamAppend = (
      type: 'text.delta' | 'progress' | 'status',
      payload: Record<string, unknown>,
    ) => {
      if (!this.client || !activeStream || streamClosed) return
      const streamId = activeStream.streamId

      let write: Promise<void>
      write = this.client.appendStreamEvent({
        streamId,
        type,
        payload,
      })
        .then(() => undefined)
        .catch((err) => {
          if (isClosedStreamAppendError(err)) {
            streamClosed = true
            return
          }
          console.warn(
            `[${this.name}] Failed to append ${type} stream event for ${task.taskId}: ${(err as Error).message}`,
          )
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

    const appendStreamEvent = async (
      type: 'text.delta' | 'progress' | 'status',
      payload: Record<string, unknown>,
    ) => {
      if (!this.client || !activeStream || streamClosed) return
      try {
        await this.client.appendStreamEvent({
          streamId: activeStream.streamId,
          type,
          payload,
        })
      } catch (err) {
        if (isClosedStreamAppendError(err)) {
          streamClosed = true
          return
        }
        throw err
      }
    }

    const closeStream = async (payload: Record<string, unknown>) => {
      if (!this.client || !activeStream || streamClosed) return
      await flushStreamWrites()
      await this.client.closeStream({
        streamId: activeStream.streamId,
        payload,
      })
      streamClosed = true
    }

    const queuePhaseStatus = (channel: AcpTextChunk['channel']) => {
      if (currentPhase === channel) return
      currentPhase = channel
      queueStreamAppend('status', {
        state: 'running',
        label: buildPhaseStatusLabel(channel),
      })
    }

    try {
      activeStream = await this.client.createStream({
        taskId: task.taskId,
        peerEmail: task.from,
      })
      await this.client.sendStreamOpened({
        to: task.from,
        taskId: task.taskId,
        streamId: activeStream.streamId,
        inReplyTo: task.messageId,
      })
      await appendStreamEvent('status', { state: 'running', label: 'ACP task started' })

      const prompt = buildPrompt(hydratedTask, hydratedTask.threadContextText, this.name)
      await this.acpx.ensureSession(this.agentConfig.acpCommand, taskSessionName)
      await appendStreamEvent('progress', { value: 0.2, label: 'Prompt sent to ACP agent' })
      const result = await this.acpx.prompt(this.agentConfig.acpCommand, taskSessionName, prompt, {
        onTextChunk: (chunk) => {
          queuePhaseStatus(chunk.channel)
          const rendered = renderTextChunk(chunk, streamTextState)
          if (!rendered) return
          queueStreamAppend('text.delta', {
            text: rendered,
            channel: chunk.channel,
            ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
          })
        },
        onToolUpdate: (update) => {
          queueStreamAppend('progress', {
            label: buildToolProgressLabel(update),
            ...(update.title ? { title: update.title } : {}),
            ...(update.status ? { status: update.status } : {}),
            ...(update.kind ? { kind: update.kind } : {}),
            ...(update.toolCallId ? { toolCallId: update.toolCallId } : {}),
          })
        },
        onPlanUpdate: (entries) => {
          queuePhaseStatus('thought')
          queueStreamAppend('text.delta', {
            text: `${streamTextState.hasContent ? '\n\n' : ''}${formatPlanUpdate(entries)}`,
            channel: 'thought',
          })
          streamTextState.hasContent = true
          streamTextState.currentChannel = 'thought'
          streamTextState.currentMessageId = undefined
        },
      })
      if (this.cancelledTaskIds.has(task.taskId)) {
        console.warn(`[${this.name}] Dropping task ${task.taskId} result because the task was cancelled`)
        return
      }
      await flushStreamWrites()
      await appendStreamEvent('progress', { value: 0.8, label: 'ACP response received' })
      const parsed = parseResponse(result.output)
      if (!parsed.isHelp
        && !parsed.output
        && parsed.files.length === 0
        && !parsed.structuredResult?.length
        && !parsed.attachments?.length) {
        throw new Error('ACP agent completed without a final response')
      }

      if (parsed.isHelp) {
        // Agent needs help
        if (!result.streamedAssistantText && parsed.question) {
          queuePhaseStatus('assistant')
          queueStreamAppend('text.delta', {
            text: renderTextChunk(
              { channel: 'assistant', text: parsed.question },
              streamTextState,
            ),
            channel: 'assistant',
          })
          await flushStreamWrites()
        }
        await appendStreamEvent('status', { state: 'help_needed', label: parsed.question ?? 'Agent requested clarification' })
        await closeStream({ reason: 'task.help_needed' })
        await this.client.sendHelp({
          to: task.from,
          taskId: task.taskId,
          question: parsed.question ?? 'Agent needs more information',
          blockedReason: 'ACP agent requested clarification',
          suggestedOptions: [],
          inReplyTo: task.messageId,
        })
        console.log(`[${this.name}] -> task.help_needed  ${task.taskId}`)
      } else {
        // Collect file attachments referenced by the agent
        const attachments: AampAttachment[] = []
        for (const attachmentRef of mergeAttachmentRefs(parsed.files, parsed.attachments)) {
          const filepath = attachmentRef.path
          if (existsSync(filepath)) {
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
          } else {
            console.warn(`[${this.name}] Attachment file not found: ${filepath}`)
          }
        }
        const structuredResult = fillStructuredResultAttachmentFilenames(
          parsed.structuredResult,
          attachments,
        )

        // Task completed
        if (parsed.output && !result.streamedAssistantText) {
          queuePhaseStatus('assistant')
          queueStreamAppend('text.delta', {
            text: renderTextChunk(
              { channel: 'assistant', text: parsed.output },
              streamTextState,
            ),
            channel: 'assistant',
          })
          await flushStreamWrites()
        }
        await closeStream({ reason: 'task.result', status: 'completed' })
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
      }
    } catch (err) {
      const errorMsg = (err as Error).message
      console.error(`[${this.name}] Task ${task.taskId} error: ${errorMsg}`)
      try {
        await flushStreamWrites()
        if (activeStream) {
          await closeStream({ reason: 'task.result', status: 'rejected', error: errorMsg })
        }
        await this.client.sendResult({
          to: task.from,
          taskId: task.taskId,
          status: 'rejected',
          output: '',
          errorMsg: `ACP agent error: ${errorMsg}`,
          inReplyTo: task.messageId,
        })
      } catch { /* best effort */ }
    } finally {
      this.activeTaskCount = Math.max(0, this.activeTaskCount - 1)
      this.activeTaskIds.delete(task.taskId)
    }
  }

  private handleCancel(task: TaskCancel): void {
    this.cancelledTaskIds.add(task.taskId)
    console.warn(`[${this.name}] <- task.cancel  ${task.taskId}  from=${task.from}`)
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
    const senderPoliciesFile = resolveSenderPoliciesFile(
      this.agentConfig.senderPoliciesFile,
      this.agentConfig.name,
    )
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

    console.log(`[${this.name}] Paired sender ${request.from}; policy saved to ${senderPoliciesFile}`)
    if (await this.sendPairResponse(request, true)) {
      consumePairingCode(pairParams)
    } else {
      console.warn(`[${this.name}] Pairing code left active so ${request.from} can retry before it expires`)
    }
  }

  /**
   * Resolve AAMP identity: load from credentials file or register new.
   */
  private async resolveIdentity(): Promise<AgentIdentity> {
    const credFile = resolveCredentialsFile(this.agentConfig.credentialsFile, this.agentConfig.name)

    // Try loading existing credentials
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

    // Self-register
    const slug = this.agentConfig.slug ?? `${this.agentConfig.name}-bridge`
    const description = this.agentConfig.description ?? `${this.agentConfig.name} via ACP bridge`

    const creds = await AampClient.registerMailbox({
      aampHost: this.aampHost,
      slug,
      description,
    })

    const identity: AgentIdentity = {
      email: creds.email,
      mailboxToken: creds.mailboxToken,
      smtpPassword: creds.smtpPassword,
    }

    // Persist credentials
    mkdirSync(dirname(credFile), { recursive: true })
    writeFileSync(credFile, JSON.stringify(identity, null, 2))
    console.log(`[${this.name}] Registered: ${identity.email} (credentials saved to ${credFile})`)

    return identity
  }
}
