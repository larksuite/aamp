/**
 * AampClient — Main SDK entry point
 *
 * Combines JMAP WebSocket Push (receive) + SMTP (send) into a single client.
 *
 * Usage:
 *
 * ```typescript
 * const client = new AampClient({
 *   email: 'codereviewer-abc@aamp.example.com',
 *   mailboxToken: '<base64(email:password)>',
 *   baseUrl: 'https://meshmail.ai',
 *   smtpPort: 587,
 *   smtpPassword: 'agent-smtp-password',
 * })
 *
 * // Listen for incoming tasks
 * client.on('task.dispatch', async (task) => {
 *   const result = await doWork(task)
 *   await client.sendResult({
 *     to: task.from,
 *     taskId: task.taskId,
 *     status: 'completed',
 *     output: result,
 *   })
 * })
 *
 * await client.connect()
 * ```
 */

import { JmapPushClient } from './jmap-push.js'
import { SmtpSender, deriveMailboxServiceDefaults } from './smtp-sender.js'
import { TinyEmitter } from './tiny-emitter.js'
import { renderThreadHistoryForAgent } from './thread.js'
import type {
  AampClientConfig,
  AampClientEvents,
  AampDiscoveryDocument,
  AgentDirectoryEntry,
  AgentDirectoryProfile,
  AgentDirectorySearchEntry,
  AampThreadEvent,
  AampMailboxIdentityConfig,
  AampStreamEvent,
  CardQuery,
  CardResponse,
  CloseStreamOptions,
  CreateStreamOptions,
  CreateStreamResult,
  DirectoryListOptions,
  DirectorySearchOptions,
  GetTaskStreamOptions,
  GetThreadHistoryOptions,
  HydratedTaskDispatch,
  RegisterMailboxOptions,
  RegisteredMailboxIdentity,
  SendCardQueryOptions,
  SendCardResponseOptions,
  SendCancelOptions,
  StreamSubscription,
  TaskCancel,
  TaskDispatch,
  TaskThreadHistory,
  TaskResult,
  TaskHelp,
  TaskAck,
  TaskStreamOpened,
  TaskStreamState,
  HumanReply,
  SendTaskOptions,
  SendResultOptions,
  SendHelpOptions,
  UpdateDirectoryProfileOptions,
} from './types.js'

type StreamAppendOperation =
  | {
    kind: 'text-delta-batch'
    text: string
    payload: Record<string, unknown>
    resolvers: Array<(event: AampStreamEvent) => void>
    rejecters: Array<(error: unknown) => void>
  }
  | {
    kind: 'single-event'
    opts: {
      streamId: string
      type: AampStreamEvent['type']
      payload: Record<string, unknown>
    }
    resolve: (event: AampStreamEvent) => void
    reject: (error: unknown) => void
  }

export class AampClient extends TinyEmitter<AampClientEvents> {
  private jmapClient: JmapPushClient
  private smtpSender: SmtpSender
  private readonly config: AampClientConfig
  private readonly streamAppendQueues = new Map<string, {
    running: boolean
    operations: StreamAppendOperation[]
  }>()

  constructor(config: AampClientConfig) {
    super()
    this.config = config

    const mailboxToken = config.mailboxToken
    const resolvedBaseUrl = config.baseUrl
    const derived = deriveMailboxServiceDefaults(config.email, resolvedBaseUrl)
    const smtpHost = config.smtpHost ?? derived.smtpHost

    // Decode mailbox token (format: base64(email:password))
    let password: string
    try {
      const decoded = Buffer.from(mailboxToken, 'base64').toString('utf-8')
      const colonIdx = decoded.indexOf(':')
      if (colonIdx < 0) throw new Error('Invalid mailboxToken format: expected base64(email:password)')
      password = decoded.slice(colonIdx + 1)
      if (!password) throw new Error('Invalid mailboxToken: empty password')
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid mailboxToken')) throw err
      throw new Error(`Failed to decode mailboxToken: ${(err as Error).message}`)
    }

    this.jmapClient = new JmapPushClient({
      email: config.email,
      password: password ?? config.smtpPassword,
      jmapUrl: resolvedBaseUrl,
      reconnectInterval: config.reconnectInterval ?? 5000,
      rejectUnauthorized: config.rejectUnauthorized,
    })

    this.smtpSender = new SmtpSender({
      host: smtpHost,
      port: config.smtpPort ?? 587,
      user: config.email,
      password: config.smtpPassword,
      httpBaseUrl: config.httpSendBaseUrl ?? resolvedBaseUrl,
      authToken: mailboxToken,
      rejectUnauthorized: config.rejectUnauthorized,
    })

    // Forward JMAP events to this emitter
    this.jmapClient.on('task.dispatch', (task: TaskDispatch) => {
      this.emit('task.dispatch', task)
    })

    this.jmapClient.on('task.cancel', (task: TaskCancel) => {
      this.emit('task.cancel', task)
    })

    this.jmapClient.on('task.result', (result: TaskResult) => {
      this.emit('task.result', result)
    })

    this.jmapClient.on('task.help_needed', (help: TaskHelp) => {
      this.emit('task.help_needed', help)
    })

    this.jmapClient.on('task.ack', (ack: TaskAck) => {
      this.emit('task.ack', ack)
    })

    this.jmapClient.on('task.stream.opened', (stream: TaskStreamOpened) => {
      this.emit('task.stream.opened', stream)
    })

    this.jmapClient.on('card.query', (query: CardQuery) => {
      this.emit('card.query', query)
    })

    this.jmapClient.on('card.response', (response: CardResponse) => {
      this.emit('card.response', response)
    })

    // Auto-ACK: when a task.dispatch is received, automatically send an ACK back
    this.jmapClient.on('_autoAck', async ({ to, taskId, messageId }: { to: string; taskId: string; messageId: string }) => {
      try {
        await this.smtpSender.sendAck({ to, taskId, inReplyTo: messageId })
      } catch (err) {
        console.warn(`[AAMP] Failed to send ACK for task ${taskId}: ${(err as Error).message}`)
      }
    })

    this.jmapClient.on('reply', (reply: HumanReply) => {
      this.emit('reply', reply)
    })

    this.jmapClient.on('connected', () => {
      this.emit('connected')
    })

    this.jmapClient.on('disconnected', (reason: string) => {
      this.emit('disconnected', reason)
    })

    this.jmapClient.on('error', (err: Error) => {
      this.emit('error', err)
    })
  }

  static fromMailboxIdentity(config: AampMailboxIdentityConfig): AampClient {
    const derived = deriveMailboxServiceDefaults(config.email, config.baseUrl)
    return new AampClient({
      email: config.email,
      mailboxToken: Buffer.from(`${config.email}:${config.smtpPassword}`).toString('base64'),
      baseUrl: derived.httpBaseUrl ?? `https://${config.email.split('@')[1] ?? 'localhost'}`,
      smtpHost: derived.smtpHost,
      smtpPort: config.smtpPort ?? 587,
      smtpPassword: config.smtpPassword,
      reconnectInterval: config.reconnectInterval,
      rejectUnauthorized: config.rejectUnauthorized,
    })
  }

  static async discoverAampService(aampHost: string): Promise<AampDiscoveryDocument> {
    const base = aampHost.replace(/\/$/, '')
    const res = await fetch(`${base}/.well-known/aamp`)
    if (!res.ok) {
      throw new Error(`AAMP discovery failed: ${res.status} ${res.statusText}`)
    }
    const discovery = await res.json() as AampDiscoveryDocument
    if (!discovery.api?.url) {
      throw new Error('AAMP discovery did not return api.url')
    }
    return discovery
  }

  private static async callDiscoveredApi(
    base: string,
    opts: {
      action: string
      method?: 'GET' | 'POST'
      query?: Record<string, string | number | boolean | undefined>
      body?: unknown
      authToken?: string
    },
  ): Promise<Response> {
    const discovery = await AampClient.discoverAampService(base)
    const apiUrl = new URL(discovery.api!.url!, `${base}/`)
    apiUrl.searchParams.set('action', opts.action)
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value == null) continue
      apiUrl.searchParams.set(key, String(value))
    }
    return fetch(apiUrl, {
      method: opts.method ?? 'GET',
      headers: {
        ...(opts.authToken ? { Authorization: `Basic ${opts.authToken}` } : {}),
        ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    })
  }

  static async registerMailbox(opts: RegisterMailboxOptions): Promise<RegisteredMailboxIdentity> {
    const base = opts.aampHost.replace(/\/$/, '')
    const registerRes = await AampClient.callDiscoveredApi(base, {
      action: 'aamp.mailbox.register',
      method: 'POST',
      body: {
        slug: opts.slug,
        description: opts.description,
      },
    })
    if (!registerRes.ok) {
      const body = await registerRes.text().catch(() => '')
      throw new Error(`Mailbox registration failed: ${registerRes.status} ${body || registerRes.statusText}`)
    }
    const registerData = await registerRes.json() as { registrationCode?: string }
    if (!registerData.registrationCode) {
      throw new Error('Mailbox registration succeeded but no registrationCode was returned')
    }

    const credsRes = await AampClient.callDiscoveredApi(base, {
      action: 'aamp.mailbox.credentials',
      query: { code: registerData.registrationCode },
    })
    if (!credsRes.ok) {
      const body = await credsRes.text().catch(() => '')
      throw new Error(`Mailbox credential exchange failed: ${credsRes.status} ${body || credsRes.statusText}`)
    }
    const creds = await credsRes.json() as {
      email?: string
      mailbox?: { token?: string }
      smtp?: { password?: string }
    }
    if (!creds.email || !creds.mailbox?.token || !creds.smtp?.password) {
      throw new Error('Mailbox credential exchange returned an incomplete identity payload')
    }

    return {
      email: creds.email,
      mailboxToken: creds.mailbox.token,
      smtpPassword: creds.smtp.password,
      baseUrl: base,
    }
  }

  // =====================================================
  // Lifecycle
  // =====================================================

  /**
   * Connect to JMAP and start listening for tasks
   */
  async connect(): Promise<void> {
    await this.jmapClient.start()
  }

  /**
   * Disconnect and clean up
   */
  disconnect(): void {
    this.jmapClient.stop()
    this.smtpSender.close()
  }

  /**
   * Returns true if the JMAP connection is active
   */
  isConnected(): boolean {
    return this.jmapClient.isConnected()
  }

  isUsingPollingFallback(): boolean {
    return this.jmapClient.isUsingPollingFallback()
  }

  // =====================================================
  // Sending
  // =====================================================

  /**
   * Send a task.dispatch email to an agent.
   * Returns the generated taskId and the SMTP Message-ID.
   * Store messageId → taskId in Redis/DB to support In-Reply-To thread routing
   * for human replies that arrive without X-AAMP headers.
   */
  async sendTask(opts: SendTaskOptions): Promise<{ taskId: string; messageId: string }> {
    return this.smtpSender.sendTask(opts)
  }

  async sendCancel(opts: SendCancelOptions): Promise<void> {
    return this.smtpSender.sendCancel(opts)
  }

  /**
   * Send a task.result email (agent → system/dispatcher)
   */
  async sendResult(opts: SendResultOptions): Promise<void> {
    return this.smtpSender.sendResult(opts)
  }

  /**
   * Send a task.help_needed email when the agent needs human assistance
   */
  async sendHelp(opts: SendHelpOptions): Promise<void> {
    return this.smtpSender.sendHelp(opts)
  }

  async sendStreamOpened(opts: {
    to: string
    taskId: string
    streamId: string
    inReplyTo?: string
  }): Promise<void> {
    return this.smtpSender.sendStreamOpened(opts)
  }

  async sendCardQuery(opts: SendCardQueryOptions): Promise<{ taskId: string; messageId: string }> {
    return this.smtpSender.sendCardQuery(opts)
  }

  async sendCardResponse(opts: SendCardResponseOptions): Promise<void> {
    return this.smtpSender.sendCardResponse(opts)
  }

  async updateDirectoryProfile(opts: UpdateDirectoryProfileOptions): Promise<AgentDirectoryProfile> {
    const base = this.config.baseUrl
    const mailboxToken = this.config.mailboxToken
    const res = await AampClient.callDiscoveredApi(base, {
      action: 'aamp.directory.upsert',
      method: 'POST',
      authToken: mailboxToken,
      body: opts,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Directory profile update failed: ${res.status} ${body || res.statusText}`)
    }
    const data = await res.json() as { profile: AgentDirectoryProfile }
    return data.profile
  }

  async listDirectory(opts: DirectoryListOptions = {}): Promise<AgentDirectoryEntry[]> {
    const base = this.config.baseUrl
    const mailboxToken = this.config.mailboxToken
    const res = await AampClient.callDiscoveredApi(base, {
      action: 'aamp.directory.list',
      authToken: mailboxToken,
      query: {
        scope: opts.scope,
        includeSelf: opts.includeSelf,
        limit: opts.limit,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Directory list failed: ${res.status} ${body || res.statusText}`)
    }
    const data = await res.json() as { agents: AgentDirectoryEntry[] }
    return data.agents
  }

  async searchDirectory(opts: DirectorySearchOptions): Promise<AgentDirectorySearchEntry[]> {
    const base = this.config.baseUrl
    const mailboxToken = this.config.mailboxToken
    const res = await AampClient.callDiscoveredApi(base, {
      action: 'aamp.directory.search',
      authToken: mailboxToken,
      query: {
        q: opts.query,
        scope: opts.scope,
        includeSelf: opts.includeSelf,
        limit: opts.limit,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Directory search failed: ${res.status} ${body || res.statusText}`)
    }
    const data = await res.json() as { agents: AgentDirectorySearchEntry[] }
    return data.agents
  }

  async getThreadHistory(taskId: string, opts: GetThreadHistoryOptions = {}): Promise<TaskThreadHistory> {
    const base = this.config.baseUrl
    const mailboxToken = this.config.mailboxToken
    const res = await AampClient.callDiscoveredApi(base, {
      action: 'aamp.mailbox.thread',
      authToken: mailboxToken,
      query: {
        taskId,
        includeStreamOpened: opts.includeStreamOpened,
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Thread history fetch failed: ${res.status} ${body || res.statusText}`)
    }
    const data = await res.json() as TaskThreadHistory
    return {
      taskId: data.taskId,
      events: Array.isArray(data.events) ? data.events : [],
    }
  }

  async hydrateTaskDispatch(task: TaskDispatch): Promise<HydratedTaskDispatch> {
    const history = await this.getThreadHistory(task.taskId)
    const priorEvents = history.events.filter((event: AampThreadEvent) => event.messageId !== task.messageId)
    return {
      ...task,
      threadHistory: priorEvents,
      threadContextText: renderThreadHistoryForAgent(priorEvents),
    }
  }

  private async resolveStreamCapability(): Promise<NonNullable<NonNullable<AampDiscoveryDocument['capabilities']>['stream']>> {
    const discovery = await AampClient.discoverAampService(this.config.baseUrl)
    const stream = discovery.capabilities?.stream
    if (!stream?.transport) {
      throw new Error('AAMP stream capability is not available on this service')
    }
    return stream
  }

  async createStream(opts: CreateStreamOptions): Promise<CreateStreamResult> {
    const stream = await this.resolveStreamCapability()
    const res = await AampClient.callDiscoveredApi(this.config.baseUrl, {
      action: stream.createAction ?? 'aamp.stream.create',
      method: 'POST',
      authToken: this.config.mailboxToken,
      body: opts,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`AAMP stream create failed: ${res.status} ${body || res.statusText}`)
    }
    return res.json() as Promise<CreateStreamResult>
  }

  private getStreamAppendQueue(streamId: string): {
    running: boolean
    operations: StreamAppendOperation[]
  } {
    let queue = this.streamAppendQueues.get(streamId)
    if (!queue) {
      queue = { running: false, operations: [] }
      this.streamAppendQueues.set(streamId, queue)
    }
    return queue
  }

  private async dispatchStreamAppend(opts: {
    streamId: string
    type: AampStreamEvent['type']
    payload: Record<string, unknown>
  }): Promise<AampStreamEvent> {
    const stream = await this.resolveStreamCapability()
    const res = await AampClient.callDiscoveredApi(this.config.baseUrl, {
      action: stream.appendAction ?? 'aamp.stream.append',
      method: 'POST',
      authToken: this.config.mailboxToken,
      body: opts,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`AAMP stream append failed: ${res.status} ${body || res.statusText}`)
    }
    return res.json() as Promise<AampStreamEvent>
  }

  private enqueueStreamAppend(
    streamId: string,
    operation: StreamAppendOperation,
  ): void {
    const queue = this.getStreamAppendQueue(streamId)
    queue.operations.push(operation)
    void this.drainStreamAppendQueue(streamId)
  }

  private async drainStreamAppendQueue(streamId: string): Promise<void> {
    const queue = this.streamAppendQueues.get(streamId)
    if (!queue || queue.running) return

    queue.running = true
    try {
      while (queue.operations.length) {
        const operation = queue.operations.shift()
        if (!operation) continue

        if (operation.kind === 'text-delta-batch') {
          try {
            const event = await this.dispatchStreamAppend({
              streamId,
              type: 'text.delta',
              payload: {
                ...operation.payload,
                text: operation.text,
              },
            })
            for (const resolve of operation.resolvers) resolve(event)
          } catch (error) {
            for (const reject of operation.rejecters) reject(error)
          }
          continue
        }

        try {
          const event = await this.dispatchStreamAppend(operation.opts)
          operation.resolve(event)
        } catch (error) {
          operation.reject(error)
        }
      }
    } finally {
      queue.running = false
      if (queue.operations.length === 0) {
        this.streamAppendQueues.delete(streamId)
      }
    }
  }

  private async flushStreamAppendQueue(streamId: string): Promise<void> {
    while (true) {
      const queue = this.streamAppendQueues.get(streamId)
      if (!queue) return
      if (!queue.running && queue.operations.length === 0) {
        this.streamAppendQueues.delete(streamId)
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  async appendStreamEvent(opts: {
    streamId: string
    type: AampStreamEvent['type']
    payload: Record<string, unknown>
  }): Promise<AampStreamEvent> {
    if (opts.type === 'text.delta' && typeof opts.payload.text === 'string') {
      return await new Promise<AampStreamEvent>((resolve, reject) => {
        const queue = this.getStreamAppendQueue(opts.streamId)
        const lastOperation = queue.operations.at(-1)
        if (lastOperation?.kind === 'text-delta-batch') {
          lastOperation.text += String(opts.payload.text ?? '')
          lastOperation.resolvers.push(resolve)
          lastOperation.rejecters.push(reject)
          return
        }

        this.enqueueStreamAppend(opts.streamId, {
          kind: 'text-delta-batch',
          text: String(opts.payload.text ?? ''),
          payload: {
            ...opts.payload,
          },
          resolvers: [resolve],
          rejecters: [reject],
        })
      })
    }

    return await new Promise<AampStreamEvent>((resolve, reject) => {
      this.enqueueStreamAppend(opts.streamId, {
        kind: 'single-event',
        opts,
        resolve,
        reject,
      })
    })
  }

  async closeStream(opts: CloseStreamOptions): Promise<TaskStreamState> {
    await this.flushStreamAppendQueue(opts.streamId)
    const stream = await this.resolveStreamCapability()
    const res = await AampClient.callDiscoveredApi(this.config.baseUrl, {
      action: stream.closeAction ?? 'aamp.stream.close',
      method: 'POST',
      authToken: this.config.mailboxToken,
      body: opts,
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`AAMP stream close failed: ${res.status} ${body || res.statusText}`)
    }
    return res.json() as Promise<TaskStreamState>
  }

  async getTaskStream(opts: GetTaskStreamOptions): Promise<TaskStreamState | null> {
    const stream = await this.resolveStreamCapability()
    const res = await AampClient.callDiscoveredApi(this.config.baseUrl, {
      action: stream.getAction ?? 'aamp.stream.get',
      authToken: this.config.mailboxToken,
      query: {
        ...(opts.taskId ? { taskId: opts.taskId } : {}),
        ...(opts.streamId ? { streamId: opts.streamId } : {}),
      },
    })
    if (res.status === 404) return null
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`AAMP stream get failed: ${res.status} ${body || res.statusText}`)
    }
    return res.json() as Promise<TaskStreamState>
  }

  async subscribeStream(
    streamId: string,
    handlers: {
      onEvent: (event: AampStreamEvent) => void
      onError?: (err: Error) => void
      onOpen?: () => void
    },
    opts: { lastEventId?: string; signal?: AbortSignal } = {},
  ): Promise<StreamSubscription> {
    const stream = await this.resolveStreamCapability()
    const template = stream.subscribeUrlTemplate
    if (!template) throw new Error('AAMP stream subscribeUrlTemplate is missing')

    const url = new URL(template.replace('{streamId}', encodeURIComponent(streamId)), this.config.baseUrl)
    if (opts.lastEventId) {
      url.searchParams.set('lastEventId', opts.lastEventId)
    }

    const controller = new AbortController()
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${this.config.mailboxToken}`,
        Accept: 'text/event-stream',
      },
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`AAMP stream subscribe failed: ${res.status} ${res.statusText}`)
    }

    handlers.onOpen?.()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let currentEvent = 'message'
    let currentId = ''
    let currentData: string[] = []

    const flush = () => {
      if (!currentData.length) return
      try {
        const parsed = JSON.parse(currentData.join('\n')) as AampStreamEvent
        handlers.onEvent({
          ...parsed,
          ...(currentId ? { id: currentId } : {}),
          type: parsed.type ?? currentEvent as AampStreamEvent['type'],
        })
      } catch (err) {
        handlers.onError?.(err as Error)
      } finally {
        currentEvent = 'message'
        currentId = ''
        currentData = []
      }
    }

    void (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let index = buffer.indexOf('\n\n')
          while (index >= 0) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            for (const rawLine of frame.split('\n')) {
              const line = rawLine.replace(/\r$/, '')
              if (!line || line.startsWith(':')) continue
              if (line.startsWith('event:')) {
                currentEvent = line.slice(6).trim()
              } else if (line.startsWith('id:')) {
                currentId = line.slice(3).trim()
              } else if (line.startsWith('data:')) {
                currentData.push(line.slice(5).trimStart())
              }
            }
            flush()
            index = buffer.indexOf('\n\n')
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          handlers.onError?.(err as Error)
        }
      } finally {
        buffer += decoder.decode()
        controller.abort()
      }
    })()

    return {
      close() {
        controller.abort()
      },
    }
  }

  /**
   * Download a blob (attachment) by its JMAP blobId.
   * Use this to retrieve attachment content from received TaskDispatch or TaskResult messages.
   * Returns the raw binary content as a Buffer.
   */
  async downloadBlob(blobId: string, filename?: string): Promise<Buffer> {
    return this.jmapClient.downloadBlob(blobId, filename)
  }

  /**
   * Reconcile recent mailbox contents via JMAP HTTP to catch messages missed by
   * a flaky WebSocket path. Safe to call periodically; duplicate processing is
   * suppressed by the JMAP push client.
   */
  async reconcileRecentEmails(limit?: number, opts?: { includeHistorical?: boolean }): Promise<number> {
    return this.jmapClient.reconcileRecentEmails(limit, opts)
  }

  /**
   * Verify SMTP connectivity
   */
  async verifySmtp(): Promise<boolean> {
    return this.smtpSender.verify()
  }

  get email(): string {
    return this.config.email
  }
}
