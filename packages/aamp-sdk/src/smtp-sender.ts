/**
 * SMTP Sender
 *
 * Sends AAMP protocol emails via SMTP (Stalwart submission port 587).
 */

import { createTransport, type Transporter } from 'nodemailer'
import { randomUUID } from 'crypto'

/** Strip CR/LF to prevent email header injection */
const sanitize = (s: string) => s.replace(/[\r\n]/g, ' ').trim()
import { buildDispatchHeaders, buildResultHeaders, buildHelpHeaders, buildAckHeaders } from './parser.js'
import type {
  SendTaskOptions,
  SendResultOptions,
  SendHelpOptions,
} from './types.js'

export interface SmtpConfig {
  host: string
  port: number
  user: string
  password: string
  httpBaseUrl?: string
  authToken?: string
  secure?: boolean
  /** Whether to reject unauthorized TLS certificates (default: true) */
  rejectUnauthorized?: boolean
}

export class SmtpSender {
  private transport: Transporter

  constructor(private readonly config: SmtpConfig) {
    this.transport = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure ?? false,
      auth: {
        user: config.user,
        pass: config.password,
      },
      tls: {
        rejectUnauthorized: config.rejectUnauthorized ?? true,
      },
    })
  }

  private senderDomain(): string {
    return this.config.user.split('@')[1]?.toLowerCase() ?? ''
  }

  private recipientDomain(email: string): string {
    return email.split('@')[1]?.toLowerCase() ?? ''
  }

  private shouldUseHttpFallback(to: string): boolean {
    return Boolean(
      this.config.httpBaseUrl
      && this.config.authToken
      && this.senderDomain()
      && this.senderDomain() === this.recipientDomain(to),
    )
  }

  private async sendViaHttp(opts: {
    to: string
    subject: string
    text: string
    aampHeaders: Record<string, string>
    attachments?: Array<{ filename: string; contentType: string; content: Buffer | string }>
  }): Promise<{ messageId?: string }> {
    const base = this.config.httpBaseUrl?.replace(/\/$/, '')
    if (!base || !this.config.authToken) {
      throw new Error('HTTP send fallback is not configured')
    }

    const res = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${this.config.authToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        aampHeaders: opts.aampHeaders,
        attachments: opts.attachments?.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          content: typeof a.content === 'string' ? a.content : a.content.toString('base64'),
        })),
      }),
    })

    const data = await res.json().catch(() => ({})) as { details?: string; messageId?: string }
    if (!res.ok) {
      throw new Error(data.details || `HTTP send failed: ${res.status}`)
    }
    return { messageId: data.messageId }
  }

  /**
   * Send a task.dispatch email.
   * Returns both the generated taskId and the SMTP Message-ID so callers can
   * store a reverse-index (messageId → taskId) for In-Reply-To thread routing.
   */
  async sendTask(opts: SendTaskOptions): Promise<{ taskId: string; messageId: string }> {
    const taskId = randomUUID()
    const aampHeaders = buildDispatchHeaders({
      taskId,
      timeoutSecs: opts.timeoutSecs,
      contextLinks: opts.contextLinks ?? [],
      parentTaskId: opts.parentTaskId,
    })

    const sendMailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Task] ${sanitize(opts.title)}`,
      text: [
        `Task: ${opts.title}`,
        `Task ID: ${taskId}`,
        opts.timeoutSecs ? `Deadline: ${opts.timeoutSecs}s` : `Deadline: none`,
        opts.contextLinks?.length
          ? `Context:\n${opts.contextLinks.map((l) => `  ${l}`).join('\n')}`
          : '',
        opts.bodyText ?? '',
        ``,
        `--- This email was sent by AAMP. Reply directly to submit your result. ---`,
      ]
        .filter(Boolean)
        .join('\n'),
      headers: aampHeaders,
    }

    if (opts.attachments?.length) {
      sendMailOpts.attachments = opts.attachments.map(a => ({
        filename: a.filename,
        content: typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : a.content,
        contentType: a.contentType,
      }))
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: sendMailOpts.subject as string,
        text: sendMailOpts.text as string,
        aampHeaders,
        attachments: opts.attachments?.map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          content: typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : a.content,
        })),
      })
      return { taskId, messageId: info.messageId ?? '' }
    }

    const info = await this.transport.sendMail(sendMailOpts)

    return { taskId, messageId: info.messageId ?? '' }
  }

  /**
   * Send a task.result email back to the dispatcher
   */
  async sendResult(opts: SendResultOptions): Promise<void> {
    const aampHeaders = buildResultHeaders({
      taskId: opts.taskId,
      status: opts.status,
      output: opts.output,
      errorMsg: opts.errorMsg,
      structuredResult: opts.structuredResult,
    })

    const mailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Result] Task ${opts.taskId} — ${opts.status}`,
      text: [
        `AAMP Task Result`,
        ``,
        `Task ID: ${opts.taskId}`,
        `Status: ${opts.status}`,
        ``,
        `Output:`,
        opts.output,
        opts.errorMsg ? `\nError: ${opts.errorMsg}` : '',
      ]
        .filter((s) => s !== '')
        .join('\n'),
      headers: aampHeaders,
    }
    if (opts.inReplyTo) {
      mailOpts.inReplyTo = opts.inReplyTo
      mailOpts.references = opts.inReplyTo
    }
    if (opts.attachments?.length) {
      mailOpts.attachments = opts.attachments.map(a => ({
        filename: a.filename,
        content: typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : a.content,
        contentType: a.contentType,
      }))
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
        attachments: opts.attachments?.map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          content: typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : a.content,
        })),
      })
      return
    }
    await this.transport.sendMail(mailOpts)
  }

  /**
   * Send a task.help email when the agent is blocked
   */
  async sendHelp(opts: SendHelpOptions): Promise<void> {
    const aampHeaders = buildHelpHeaders({
      taskId: opts.taskId,
      question: opts.question,
      blockedReason: opts.blockedReason,
      suggestedOptions: opts.suggestedOptions,
    })

    const helpMailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Help] Task ${opts.taskId} needs assistance`,
      text: [
        `AAMP Task Help Request`,
        ``,
        `Task ID: ${opts.taskId}`,
        ``,
        `Question: ${opts.question}`,
        ``,
        `Blocked reason: ${opts.blockedReason}`,
        ``,
        opts.suggestedOptions.length
          ? `Suggested options:\n${opts.suggestedOptions.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      headers: aampHeaders,
    }
    if (opts.inReplyTo) {
      helpMailOpts.inReplyTo = opts.inReplyTo
      helpMailOpts.references = opts.inReplyTo
    }
    if (opts.attachments?.length) {
      helpMailOpts.attachments = opts.attachments.map(a => ({
        filename: a.filename,
        content: typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : a.content,
        contentType: a.contentType,
      }))
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      await this.sendViaHttp({
        to: opts.to,
        subject: helpMailOpts.subject as string,
        text: helpMailOpts.text as string,
        aampHeaders,
        attachments: opts.attachments?.map(a => ({
          filename: a.filename,
          contentType: a.contentType,
          content: typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : a.content,
        })),
      })
      return
    }
    await this.transport.sendMail(helpMailOpts)
  }

  /**
   * Send a task.ack email to confirm receipt of a dispatch
   */
  async sendAck(opts: { to: string; taskId: string; inReplyTo?: string }): Promise<void> {
    const aampHeaders = buildAckHeaders({ taskId: opts.taskId })
    const mailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP ACK] Task ${opts.taskId}`,
      text: '',
      headers: aampHeaders,
    }
    if (opts.inReplyTo) {
      mailOpts.inReplyTo = opts.inReplyTo
      mailOpts.references = opts.inReplyTo
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
      })
      return
    }
    await this.transport.sendMail(mailOpts)
  }

  /**
   * Verify SMTP connection
   */
  async verify(): Promise<boolean> {
    try {
      await this.transport.verify()
      return true
    } catch {
      return false
    }
  }

  close(): void {
    this.transport.close()
  }
}
