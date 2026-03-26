/**
 * AampClient — Main SDK entry point
 *
 * Combines JMAP WebSocket Push (receive) + SMTP (send) into a single client.
 *
 * Usage:
 *
 * ```typescript
 * const client = new AampClient({
 *   email: 'codereviewer-abc@meshmail.ai',
 *   jmapToken: '<base64-token>',
 *   jmapUrl: 'http://localhost:8080',
 *   smtpHost: 'localhost',
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

import { EventEmitter } from 'events'
import { JmapPushClient } from './jmap-push.js'
import { SmtpSender } from './smtp-sender.js'
import type {
  AampClientConfig,
  AampClientEvents,
  TaskDispatch,
  TaskResult,
  TaskHelp,
  TaskAck,
  HumanReply,
  SendTaskOptions,
  SendResultOptions,
  SendHelpOptions,
} from './types.js'

export class AampClient extends EventEmitter {
  private jmapClient: JmapPushClient
  private smtpSender: SmtpSender
  private readonly config: AampClientConfig

  constructor(config: AampClientConfig) {
    super()
    this.config = config

    // Decode JMAP token (format: base64(email:password))
    let password: string
    try {
      const decoded = Buffer.from(config.jmapToken, 'base64').toString('utf-8')
      const colonIdx = decoded.indexOf(':')
      if (colonIdx < 0) throw new Error('Invalid jmapToken format: expected base64(email:password)')
      password = decoded.slice(colonIdx + 1)
      if (!password) throw new Error('Invalid jmapToken: empty password')
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Invalid jmapToken')) throw err
      throw new Error(`Failed to decode jmapToken: ${(err as Error).message}`)
    }

    this.jmapClient = new JmapPushClient({
      email: config.email,
      password: password ?? config.smtpPassword,
      jmapUrl: config.jmapUrl,
      reconnectInterval: config.reconnectInterval ?? 5000,
      rejectUnauthorized: config.rejectUnauthorized,
    })

    this.smtpSender = new SmtpSender({
      host: config.smtpHost,
      port: config.smtpPort ?? 587,
      user: config.email,
      password: config.smtpPassword,
      httpBaseUrl: config.httpSendBaseUrl ?? config.jmapUrl,
      authToken: config.jmapToken,
      rejectUnauthorized: config.rejectUnauthorized,
    })

    // Forward JMAP events to this emitter
    this.jmapClient.on('task.dispatch', (task: TaskDispatch) => {
      this.emit('task.dispatch', task)
    })

    this.jmapClient.on('task.result', (result: TaskResult) => {
      this.emit('task.result', result)
    })

    this.jmapClient.on('task.help', (help: TaskHelp) => {
      this.emit('task.help', help)
    })

    this.jmapClient.on('task.ack', (ack: TaskAck) => {
      this.emit('task.ack', ack)
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

  // =====================================================
  // Type-safe event emitter methods
  // =====================================================

  override on<K extends keyof AampClientEvents>(
    event: K,
    listener: AampClientEvents[K],
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  override once<K extends keyof AampClientEvents>(
    event: K,
    listener: AampClientEvents[K],
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void)
  }

  override off<K extends keyof AampClientEvents>(
    event: K,
    listener: AampClientEvents[K],
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void)
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

  /**
   * Send a task.result email (agent → system/dispatcher)
   */
  async sendResult(opts: SendResultOptions): Promise<void> {
    return this.smtpSender.sendResult(opts)
  }

  /**
   * Send a task.help email when the agent needs human assistance
   */
  async sendHelp(opts: SendHelpOptions): Promise<void> {
    return this.smtpSender.sendHelp(opts)
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
  async reconcileRecentEmails(limit?: number): Promise<number> {
    return this.jmapClient.reconcileRecentEmails(limit)
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
