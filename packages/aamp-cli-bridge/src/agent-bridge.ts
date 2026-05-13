import {
  AampClient,
  type AampAttachment,
  type AampThreadEvent,
  type TaskCancel,
  type TaskDispatch,
} from 'aamp-sdk'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { AgentConfig, BridgeConfig } from './config.js'
import { CliAgentClient } from './cli-agent-client.js'
import { resolveCliProfile } from './cli-profiles.js'
import { buildPrompt, parseResponse } from './prompt-builder.js'
import { resolveCredentialsFile } from './storage.js'
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

function threadAlreadyTerminal(events: AampThreadEvent[] | undefined): boolean {
  return (events ?? []).some((event) =>
    event.intent === 'task.result' || event.intent === 'task.cancel',
  )
}

export class AgentBridge {
  private client: AampClient | null = null
  private identity: AgentIdentity | null = null
  private cli: CliAgentClient
  private activeTaskCount = 0
  private pollingFallback = false
  private cancelledTaskIds = new Set<string>()
  private profileLabel: string
  private streamEnabled: boolean

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

  async start(): Promise<void> {
    this.identity = await this.resolveIdentity()
    console.log(`[${this.name}] AAMP identity: ${this.identity.email}`)
    console.log(`[${this.name}] CLI profile: ${this.profileLabel}`)

    this.client = AampClient.fromMailboxIdentity({
      email: this.identity.email,
      smtpPassword: this.identity.smtpPassword,
      baseUrl: this.aampHost,
      rejectUnauthorized: this.rejectUnauthorized,
    })
    const client = this.client

    client.on('task.dispatch', (task: TaskDispatch) => {
      return this.handleTask(task).catch((err) => {
        console.error(`[${this.name}] Task ${task.taskId} failed: ${(err as Error).message}`)
      })
    })

    client.on('task.cancel', (task: TaskCancel) => {
      this.cancelledTaskIds.add(task.taskId)
      console.warn(`[${this.name}] <- task.cancel  ${task.taskId}  from=${task.from}`)
    })

    client.on('connected', () => {
      this.pollingFallback = client.isUsingPollingFallback()
      console.log(`[${this.name}] AAMP connected${this.pollingFallback ? ' (polling fallback)' : ''}`)
    })

    client.on('disconnected', (reason: string) => {
      this.pollingFallback = client.isUsingPollingFallback()
      console.warn(`[${this.name}] AAMP disconnected: ${reason}`)
    })

    client.on('error', (err: Error) => {
      if (err.message.includes('falling back to polling')) {
        this.pollingFallback = true
        console.warn(`[${this.name}] ${err.message}`)
        return
      }
      console.error(`[${this.name}] AAMP error: ${err.message}`)
    })

    await client.connect()
    await this.syncDirectoryProfile().catch((err) => {
      console.warn(`[${this.name}] Directory profile sync failed: ${(err as Error).message}`)
    })
  }

  stop(): void {
    this.client?.disconnect()
    this.client = null
  }

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
    let activeStream: Awaited<ReturnType<AampClient['createStream']>> | null = null
    const pendingStreamWrites = new Set<Promise<void>>()

    const queueStreamAppend = (
      type: 'text.delta' | 'progress' | 'status' | 'error' | 'done',
      payload: Record<string, unknown>,
    ) => {
      if (!this.client || !activeStream) return
      const streamId = activeStream.streamId
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
          await this.client.sendStreamOpened({
            to: task.from,
            taskId: task.taskId,
            streamId: activeStream.streamId,
            inReplyTo: task.messageId,
          })
          await this.client.appendStreamEvent({
            streamId: activeStream.streamId,
            type: 'status',
            payload: { state: 'running', label: 'CLI task started' },
          })
        } catch (err) {
          activeStream = null
          console.warn(`[${this.name}] AAMP stream unavailable for ${task.taskId}: ${(err as Error).message}`)
        }
      }

      const prompt = buildPrompt(hydratedTask, hydratedTask.threadContextText)
      const result = await this.cli.prompt(hydratedTask.sessionKey, prompt, {
        onStreamUpdate: handleStreamUpdate,
      })
      if (this.cancelledTaskIds.has(task.taskId)) {
        console.warn(`[${this.name}] Dropping task ${task.taskId} result because the task was cancelled`)
        return
      }
      await flushStreamWrites()

      const parsed = parseResponse(result.output)
      if (parsed.isHelp) {
        if (activeStream) {
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
      for (const filepath of parsed.files) {
        if (!existsSync(filepath)) continue
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

      if (activeStream) {
        await this.client.closeStream({
          streamId: activeStream.streamId,
          payload: { reason: 'task.result', status: 'completed' },
        })
      }
      await this.client.sendResult({
        to: task.from,
        taskId: task.taskId,
        status: 'completed',
        output: parsed.output,
        inReplyTo: task.messageId,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
      console.log(`[${this.name}] -> task.result  ${task.taskId}  completed${attachments.length ? ` (${attachments.length} attachment(s))` : ''}`)
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
      } catch { /* best effort */ }
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
