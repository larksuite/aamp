import {
  AampClient,
  type TaskDispatch,
  type AampAttachment,
  type TaskCancel,
  type AampThreadEvent,
} from 'aamp-sdk'
import {
  AcpxClient,
  type AcpPlanEntry,
  type AcpTextChunk,
  type AcpToolUpdate,
} from './acpx-client.js'
import { buildPrompt, parseResponse } from './prompt-builder.js'
import type { AgentConfig } from './config.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { resolveCredentialsFile } from './storage.js'

export interface AgentIdentity {
  email: string
  mailboxToken: string
  smtpPassword: string
}

function matchSenderPolicy(
  task: TaskDispatch,
  senderPolicies: AgentConfig['senderPolicies'],
): { allowed: boolean; reason?: string } {
  if (!senderPolicies?.length) return { allowed: true }

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

  private async syncDirectoryProfile(): Promise<void> {
    if (!this.client) return

    const summary = this.agentConfig.summary?.trim() || this.agentConfig.description?.trim()
    const cardText = this.getConfiguredCardText()

    if (!summary && !cardText) return

    await this.client.updateDirectoryProfile({
      ...(summary ? { summary } : {}),
      ...(cardText ? { cardText } : {}),
    })

    console.log(
      `[${this.name}] Directory profile synced${cardText ? ' (card text registered)' : ''}`,
    )
  }

  /**
   * Start the bridge: resolve identity → connect AAMP → ensure ACP session.
   */
  async start(): Promise<void> {
    // 1. Resolve AAMP identity
    this.identity = await this.resolveIdentity()
    console.log(`[${this.name}] AAMP identity: ${this.identity.email}`)

    // 2. Create AAMP client
    this.client = AampClient.fromMailboxIdentity({
      email: this.identity.email,
      smtpPassword: this.identity.smtpPassword,
      baseUrl: this.aampHost,
      rejectUnauthorized: this.rejectUnauthorized,
    })
    const client = this.client

    // 3. Wire up task handler
    client.on('task.dispatch', (task: TaskDispatch) => {
      return this.handleTask(task).catch((err) => {
        console.error(`[${this.name}] Task ${task.taskId} failed: ${(err as Error).message}`)
      })
    })

    client.on('task.cancel', (task: TaskCancel) => {
      this.handleCancel(task)
    })

    client.on('connected', () => {
      const usingPollingFallback = client.isUsingPollingFallback()
      this.pollingFallback = usingPollingFallback
      if (usingPollingFallback) {
        if (this.transportMode !== 'polling') {
          console.warn(`[${this.name}] AAMP connected (polling fallback active)`)
        }
        this.transportMode = 'polling'
      } else {
        const previousMode = this.transportMode
        this.transportMode = 'websocket'
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
          console.warn(`[${this.name}] AAMP WebSocket unavailable, using polling fallback: ${reason}`)
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
          console.warn(`[${this.name}] ${err.message}`)
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
    await this.syncDirectoryProfile().catch((err) => {
      console.warn(`[${this.name}] Directory profile sync failed: ${(err as Error).message}`)
    })

    // 5. Ensure ACP session
    try {
      await this.acpx.ensureSession(this.agentConfig.acpCommand, this.sessionName)
      console.log(`[${this.name}] ACP session ready: ${this.sessionName}`)
    } catch (err) {
      console.warn(`[${this.name}] ACP session setup deferred: ${(err as Error).message}`)
    }
  }

  /**
   * Stop the bridge.
   */
  stop(): void {
    this.client?.disconnect()
    this.client = null
  }

  /**
   * Handle an incoming AAMP task by forwarding to the ACP agent.
   */
  private async handleTask(task: TaskDispatch): Promise<void> {
    if (!this.client) return

    console.log(`[${this.name}] <- task.dispatch  ${task.taskId}  "${task.title}"  from=${task.from}`)

    if (task.expiresAt && new Date(task.expiresAt).getTime() <= Date.now()) {
      console.warn(`[${this.name}] Skipping expired task ${task.taskId}`)
      return
    }

    if (this.cancelledTaskIds.has(task.taskId)) {
      console.warn(`[${this.name}] Ignoring cancelled task ${task.taskId}`)
      return
    }

    const senderDecision = matchSenderPolicy(task, this.agentConfig.senderPolicies)
    if (!senderDecision.allowed) {
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

    const hydratedTask = await this.client.hydrateTaskDispatch(task).catch((err) => {
      console.warn(`[${this.name}] Failed to load thread history for ${task.taskId}: ${(err as Error).message}`)
      return {
        ...task,
        threadHistory: [],
        threadContextText: '',
      }
    })

    if (threadAlreadyTerminal(hydratedTask.threadHistory)) {
      console.log(`[${this.name}] Skipping historical task ${task.taskId} because the thread already reached a terminal state`)
      return
    }

    this.activeTaskCount += 1
    const taskSessionName = this.resolveTaskSessionName(hydratedTask)
    let activeStream: Awaited<ReturnType<AampClient['createStream']>> | null = null
    let streamWrites: Promise<void> = Promise.resolve()
    const streamTextState: StreamTextRenderState = { hasContent: false }
    let currentPhase: AcpTextChunk['channel'] | null = null

    const queueStreamAppend = (
      type: 'text.delta' | 'progress' | 'status',
      payload: Record<string, unknown>,
    ) => {
      if (!this.client || !activeStream) return
      const streamId = activeStream.streamId

      streamWrites = streamWrites
        .then(async () => {
          await this.client!.appendStreamEvent({
            streamId,
            type,
            payload,
          })
        })
        .catch((err) => {
          console.warn(
            `[${this.name}] Failed to append ${type} stream event for ${task.taskId}: ${(err as Error).message}`,
          )
        })
    }

    const flushStreamWrites = async () => {
      await streamWrites
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
      await this.client.appendStreamEvent({
        streamId: activeStream.streamId,
        type: 'status',
        payload: { state: 'running', label: 'ACP task started' },
      })

      const prompt = buildPrompt(hydratedTask, hydratedTask.threadContextText)
      await this.acpx.ensureSession(this.agentConfig.acpCommand, taskSessionName)
      await this.client.appendStreamEvent({
        streamId: activeStream.streamId,
        type: 'progress',
        payload: { value: 0.2, label: 'Prompt sent to ACP agent' },
      })
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
      await this.client.appendStreamEvent({
        streamId: activeStream.streamId,
        type: 'progress',
        payload: { value: 0.8, label: 'ACP response received' },
      })
      const parsed = parseResponse(result.output)

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
        await this.client.appendStreamEvent({
          streamId: activeStream.streamId,
          type: 'status',
          payload: { state: 'help_needed', label: parsed.question ?? 'Agent requested clarification' },
        })
        await this.client.closeStream({
          streamId: activeStream.streamId,
          payload: { reason: 'task.help_needed' },
        })
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
        for (const filepath of parsed.files) {
          if (existsSync(filepath)) {
            try {
              attachments.push({
                filename: basename(filepath),
                contentType: 'application/octet-stream',
                content: readFileSync(filepath),
              })
              console.log(`[${this.name}] Attaching file: ${filepath}`)
            } catch (err) {
              console.warn(`[${this.name}] Failed to read file ${filepath}: ${(err as Error).message}`)
            }
          }
        }

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
        await this.client.closeStream({
          streamId: activeStream.streamId,
          payload: { reason: 'task.result', status: 'completed' },
        })
        await this.client.sendResult({
          to: task.from,
          taskId: task.taskId,
          status: 'completed',
          output: parsed.output,
          inReplyTo: task.messageId,
          attachments: attachments.length > 0 ? attachments : undefined,
        })
        console.log(`[${this.name}] -> task.result  ${task.taskId}  completed${attachments.length ? ` (${attachments.length} attachment(s))` : ''}`)
      }
    } catch (err) {
      const errorMsg = (err as Error).message
      console.error(`[${this.name}] Task ${task.taskId} error: ${errorMsg}`)
      try {
        await flushStreamWrites()
        if (activeStream) {
          await this.client.closeStream({
            streamId: activeStream.streamId,
            payload: { reason: 'task.result', status: 'rejected', error: errorMsg },
          })
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
    }
  }

  private handleCancel(task: TaskCancel): void {
    this.cancelledTaskIds.add(task.taskId)
    console.warn(`[${this.name}] <- task.cancel  ${task.taskId}  from=${task.from}`)
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

    const discoveryRes = await fetch(`${this.aampHost}/.well-known/aamp`)
    if (!discoveryRes.ok) throw new Error(`AAMP discovery failed: ${discoveryRes.status}`)
    const discovery = await discoveryRes.json() as { api?: { url?: string } }
    const apiUrl = discovery.api?.url
    if (!apiUrl) throw new Error('AAMP discovery did not return api.url')
    const apiBase = new URL(apiUrl, `${this.aampHost}/`).toString()

    // Step 1: Register
    const regRes = await fetch(`${apiBase}?action=aamp.mailbox.register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, description }),
    })
    if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status} ${await regRes.text()}`)
    const regData = await regRes.json() as { registrationCode: string; email: string }

    // Step 2: Exchange code for credentials
    const credRes = await fetch(`${apiBase}?action=aamp.mailbox.credentials&code=${encodeURIComponent(regData.registrationCode)}`)
    if (!credRes.ok) throw new Error(`Credential exchange failed: ${credRes.status}`)
    const creds = await credRes.json() as { email: string; mailbox: { token: string }; smtp: { password: string } }

    const identity: AgentIdentity = {
      email: creds.email,
      mailboxToken: creds.mailbox.token,
      smtpPassword: creds.smtp.password,
    }

    // Persist credentials
    mkdirSync(dirname(credFile), { recursive: true })
    writeFileSync(credFile, JSON.stringify(identity, null, 2))
    console.log(`[${this.name}] Registered: ${identity.email} (credentials saved to ${credFile})`)

    return identity
  }
}
