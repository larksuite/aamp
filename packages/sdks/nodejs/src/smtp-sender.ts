/**
 * SMTP Sender
 *
 * Sends AAMP protocol emails via SMTP (Stalwart submission port 587).
 */

import { createTransport, type Transporter } from 'nodemailer'
import { randomUUID } from 'crypto'

/** Strip CR/LF to prevent email header injection */
const sanitize = (s: string) => s.replace(/[\r\n]/g, ' ').trim()
import {
  buildDispatchHeaders,
  buildCancelHeaders,
  buildResultHeaders,
  buildHelpHeaders,
  buildAckHeaders,
  buildStreamOpenedHeaders,
  buildCardQueryHeaders,
  buildCardResponseHeaders,
} from './parser.js'
import type {
  SendTaskOptions,
  SendResultOptions,
  SendHelpOptions,
  SendCardQueryOptions,
  SendCardResponseOptions,
  SendCancelOptions,
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

export interface MailboxIdentityConfig {
  email: string
  password: string
  baseUrl?: string
  smtpPort?: number
  secure?: boolean
  rejectUnauthorized?: boolean
}

export function deriveMailboxServiceDefaults(email: string, baseUrl?: string): {
  smtpHost: string
  httpBaseUrl?: string
} {
  const domain = email.split('@')[1]?.trim()
  const resolvedBaseUrl = baseUrl?.trim() || (domain ? `https://${domain}` : undefined)
  const smtpHost = domain || (resolvedBaseUrl ? new URL(resolvedBaseUrl).hostname : 'localhost')
  return {
    smtpHost,
    httpBaseUrl: resolvedBaseUrl,
  }
}

export class SmtpSender {
  private transport: Transporter
  private discoveredApiUrlPromise: Promise<string> | null = null
  private jmapSessionPromise: Promise<{
    accountId: string
    apiUrl: string
  }> | null = null
  private sentMailboxIdPromise: Promise<string | null> | null = null

  static fromMailboxIdentity(config: MailboxIdentityConfig): SmtpSender {
    const derived = deriveMailboxServiceDefaults(config.email, config.baseUrl)
    return new SmtpSender({
      host: derived.smtpHost,
      port: config.smtpPort ?? 587,
      user: config.email,
      password: config.password,
      httpBaseUrl: derived.httpBaseUrl,
      authToken: Buffer.from(`${config.email}:${config.password}`).toString('base64'),
      secure: config.secure,
      rejectUnauthorized: config.rejectUnauthorized,
    })
  }

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

  private async resolveAampApiUrl(): Promise<string> {
    const base = this.config.httpBaseUrl?.replace(/\/$/, '')
    if (!base) {
      throw new Error('HTTP send fallback is not configured')
    }

    if (!this.discoveredApiUrlPromise) {
      this.discoveredApiUrlPromise = (async () => {
        const discoveryRes = await fetch(`${base}/.well-known/aamp`)
        if (!discoveryRes.ok) {
          throw new Error(`AAMP discovery failed: ${discoveryRes.status}`)
        }
        const discovery = await discoveryRes.json() as { api?: { url?: string } }
        if (!discovery.api?.url) {
          throw new Error('AAMP discovery did not return api.url')
        }
        return new URL(discovery.api.url, `${base}/`).toString()
      })()
    }

    try {
      return await this.discoveredApiUrlPromise
    } catch (err) {
      this.discoveredApiUrlPromise = null
      throw err
    }
  }

  private async sendViaHttp(opts: {
    to: string
    subject: string
    text: string
    aampHeaders: Record<string, string>
    attachments?: Array<{ filename: string; contentType: string; content: Buffer | string }>
  }): Promise<{ messageId?: string }> {
    if (!this.config.authToken) {
      throw new Error('HTTP send fallback is not configured')
    }
    const apiUrl = new URL(await this.resolveAampApiUrl())
    apiUrl.searchParams.set('action', 'aamp.mailbox.send')

    const res = await fetch(apiUrl, {
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

  private canPersistSentCopy(): boolean {
    return Boolean(this.config.httpBaseUrl && this.config.authToken)
  }

  private getJmapAuthHeader(): string {
    if (!this.config.authToken) {
      throw new Error('JMAP auth token is not configured')
    }
    return `Basic ${this.config.authToken}`
  }

  private async resolveJmapSession(): Promise<{ accountId: string; apiUrl: string }> {
    const base = this.config.httpBaseUrl?.replace(/\/$/, '')
    if (!base) {
      throw new Error('JMAP base URL is not configured')
    }

    if (!this.jmapSessionPromise) {
      this.jmapSessionPromise = (async () => {
        const res = await fetch(`${base}/.well-known/jmap`, {
          headers: { Authorization: this.getJmapAuthHeader() },
        })
        if (!res.ok) {
          throw new Error(`JMAP session failed: ${res.status} ${res.statusText}`)
        }

        const session = await res.json() as {
          accounts?: Record<string, unknown>
          primaryAccounts?: Record<string, string>
        }
        const accountId =
          session.primaryAccounts?.['urn:ietf:params:jmap:mail']
          ?? Object.keys(session.accounts ?? {})[0]

        if (!accountId) {
          throw new Error('No JMAP mail account available')
        }

        return {
          accountId,
          apiUrl: `${base}/jmap/`,
        }
      })()
    }

    try {
      return await this.jmapSessionPromise
    } catch (err) {
      this.jmapSessionPromise = null
      throw err
    }
  }

  private async jmapCall(
    methodCalls: Array<[string, Record<string, unknown>, string]>,
  ): Promise<Array<[string, Record<string, unknown>, string]>> {
    const session = await this.resolveJmapSession()
    const res = await fetch(session.apiUrl, {
      method: 'POST',
      headers: {
        Authorization: this.getJmapAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        using: [
          'urn:ietf:params:jmap:core',
          'urn:ietf:params:jmap:mail',
        ],
        methodCalls: methodCalls.map(([name, args, tag]) => [
          name,
          { accountId: session.accountId, ...args },
          tag,
        ]),
      }),
    })

    if (!res.ok) {
      throw new Error(`JMAP API call failed: ${res.status}`)
    }

    const data = await res.json() as {
      methodResponses?: Array<[string, Record<string, unknown>, string]>
    }
    return data.methodResponses ?? []
  }

  private async getSentMailboxId(): Promise<string | null> {
    if (!this.sentMailboxIdPromise) {
      this.sentMailboxIdPromise = (async () => {
        const responses = await this.jmapCall([
          ['Mailbox/get', { ids: null }, 'mb1'],
        ])
        const result = responses.find(([name]) => name === 'Mailbox/get')?.[1] as
          | { list?: Array<{ id: string; role: string | null }> }
          | undefined
        const mailboxes = result?.list ?? []
        return mailboxes.find((mailbox) => mailbox.role === 'sent')?.id ?? mailboxes[0]?.id ?? null
      })()
    }

    try {
      return await this.sentMailboxIdPromise
    } catch (err) {
      this.sentMailboxIdPromise = null
      throw err
    }
  }

  private async saveToSent(params: {
    from: string
    to: string
    subject: string
    text: string
    aampHeaders: Record<string, string>
    messageId?: string
    inReplyTo?: string
    references?: string
  }): Promise<void> {
    if (!this.canPersistSentCopy()) return

    const sentMailboxId = await this.getSentMailboxId()
    if (!sentMailboxId) return

    const emailCreate: Record<string, unknown> = {
      mailboxIds: { [sentMailboxId]: true },
      from: [{ email: params.from }],
      to: [{ email: params.to }],
      subject: params.subject,
      bodyValues: {
        body: {
          value: params.text,
          charset: 'utf-8',
        },
      },
      textBody: [{ partId: 'body', type: 'text/plain' }],
      keywords: { '$seen': true },
    }

    if (params.inReplyTo) {
      emailCreate['header:In-Reply-To:asText'] = ` ${sanitize(params.inReplyTo)}`
    }
    if (params.messageId) {
      emailCreate['header:Message-ID:asText'] = ` ${sanitize(params.messageId)}`
    }
    if (params.references) {
      emailCreate['header:References:asText'] = ` ${sanitize(params.references)}`
    }
    for (const [name, value] of Object.entries(params.aampHeaders)) {
      emailCreate[`header:${name}:asText`] = ` ${value}`
    }

    await this.jmapCall([
      ['Email/set', { create: { sent1: emailCreate } }, 'sent1'],
    ])
  }

  private async saveToSentBestEffort(params: {
    from: string
    to: string
    subject: string
    text: string
    aampHeaders: Record<string, string>
    messageId?: string
    inReplyTo?: string
    references?: string
  }): Promise<void> {
    if (!this.canPersistSentCopy()) return
    try {
      await this.saveToSent(params)
    } catch {
      // Non-fatal: mail delivery already succeeded, Sent copy is only for visibility/debugging.
    }
  }

  /**
   * Send a task.dispatch email.
   * Returns both the generated taskId and the SMTP Message-ID so callers can
   * store a reverse-index (messageId → taskId) for In-Reply-To thread routing.
   */
  async sendTask(opts: SendTaskOptions): Promise<{ taskId: string; messageId: string }> {
    const taskId = opts.taskId ?? randomUUID()
    const aampHeaders = buildDispatchHeaders({
      taskId,
      priority: opts.priority,
      expiresAt: opts.expiresAt,
      dispatchContext: opts.dispatchContext,
      parentTaskId: opts.parentTaskId,
    })

    const sendMailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Task] ${sanitize(opts.title)}`,
      text: opts.rawBodyText ?? [
        `Task: ${opts.title}`,
        `Task ID: ${taskId}`,
        `Priority: ${opts.priority ?? 'normal'}`,
        opts.expiresAt ? `Expires At: ${opts.expiresAt}` : `Expires At: none`,
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
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: sendMailOpts.subject as string,
        text: sendMailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
      })
      return { taskId, messageId: info.messageId ?? '' }
    }

    const info = await this.transport.sendMail(sendMailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: sendMailOpts.subject as string,
      text: sendMailOpts.text as string,
      aampHeaders,
      messageId: info.messageId,
    })

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
      text: opts.rawBodyText ?? [
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
      const info = await this.sendViaHttp({
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
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
        inReplyTo: opts.inReplyTo,
        references: opts.inReplyTo,
      })
      return
    }
    const info = await this.transport.sendMail(mailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: mailOpts.subject as string,
      text: mailOpts.text as string,
      aampHeaders,
      messageId: info.messageId,
      inReplyTo: opts.inReplyTo,
      references: opts.inReplyTo,
    })
  }

  /**
   * Send a task.help_needed email when the agent is blocked
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
      text: opts.rawBodyText ?? [
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
      const info = await this.sendViaHttp({
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
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: helpMailOpts.subject as string,
        text: helpMailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
        inReplyTo: opts.inReplyTo,
        references: opts.inReplyTo,
      })
      return
    }
    const info = await this.transport.sendMail(helpMailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: helpMailOpts.subject as string,
      text: helpMailOpts.text as string,
      aampHeaders,
      messageId: info.messageId,
      inReplyTo: opts.inReplyTo,
      references: opts.inReplyTo,
    })
  }

  /**
   * Send a task.cancel email to stop a previously dispatched task.
   */
  async sendCancel(opts: SendCancelOptions): Promise<void> {
    const aampHeaders = buildCancelHeaders({
      taskId: opts.taskId,
    })

    const mailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Cancel] Task ${opts.taskId}`,
      text: opts.bodyText ?? 'The dispatcher cancelled this task.',
      headers: aampHeaders,
    }
    if (opts.inReplyTo) {
      mailOpts.inReplyTo = opts.inReplyTo
      mailOpts.references = opts.inReplyTo
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
      })
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
        inReplyTo: opts.inReplyTo,
        references: opts.inReplyTo,
      })
      return
    }
    const info = await this.transport.sendMail(mailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: mailOpts.subject as string,
      text: mailOpts.text as string,
      aampHeaders,
      messageId: info.messageId,
      inReplyTo: opts.inReplyTo,
      references: opts.inReplyTo,
    })
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
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
      })
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
        inReplyTo: opts.inReplyTo,
        references: opts.inReplyTo,
      })
      return
    }
    const info = await this.transport.sendMail(mailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: mailOpts.subject as string,
      text: mailOpts.text as string,
      aampHeaders,
      messageId: info.messageId,
      inReplyTo: opts.inReplyTo,
      references: opts.inReplyTo,
    })
  }

  async sendStreamOpened(opts: {
    to: string
    taskId: string
    streamId: string
    inReplyTo?: string
  }): Promise<void> {
    const aampHeaders = buildStreamOpenedHeaders({
      taskId: opts.taskId,
      streamId: opts.streamId,
    })
    const mailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Stream] Task ${opts.taskId}`,
      text: `AAMP task stream is ready.\n\nTask ID: ${opts.taskId}\nStream ID: ${opts.streamId}`,
      headers: aampHeaders,
    }
    if (opts.inReplyTo) {
      mailOpts.inReplyTo = opts.inReplyTo
      mailOpts.references = opts.inReplyTo
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
      })
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
        inReplyTo: opts.inReplyTo,
        references: opts.inReplyTo,
      })
      return
    }

    const info = await this.transport.sendMail(mailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: mailOpts.subject as string,
      text: mailOpts.text as string,
      aampHeaders,
      messageId: info.messageId,
      inReplyTo: opts.inReplyTo,
      references: opts.inReplyTo,
    })
  }

  async sendCardQuery(opts: SendCardQueryOptions): Promise<{ taskId: string; messageId: string }> {
    const taskId = opts.taskId ?? randomUUID()
    const aampHeaders = buildCardQueryHeaders({ taskId })
    const mailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Card Query] ${taskId}`,
      text: opts.bodyText?.trim() || 'Please share your agent card and capability details.',
      headers: aampHeaders,
    }
    if (opts.inReplyTo) {
      mailOpts.inReplyTo = opts.inReplyTo
      mailOpts.references = opts.inReplyTo
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
      })
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
        inReplyTo: opts.inReplyTo,
        references: opts.inReplyTo,
      })
      return { taskId, messageId: info.messageId ?? '' }
    }

    const info = await this.transport.sendMail(mailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: mailOpts.subject as string,
      text: mailOpts.text as string,
      aampHeaders,
      messageId: info.messageId,
      inReplyTo: opts.inReplyTo,
      references: opts.inReplyTo,
    })
    return { taskId, messageId: info.messageId ?? '' }
  }

  async sendCardResponse(opts: SendCardResponseOptions): Promise<void> {
    const aampHeaders = buildCardResponseHeaders({
      taskId: opts.taskId,
      summary: opts.summary,
    })
    const mailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Card] ${sanitize(opts.summary)}`,
      text: opts.bodyText,
      headers: aampHeaders,
    }
    if (opts.inReplyTo) {
      mailOpts.inReplyTo = opts.inReplyTo
      mailOpts.references = opts.inReplyTo
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
      })
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
        inReplyTo: opts.inReplyTo,
        references: opts.inReplyTo,
      })
      return
    }

    const info = await this.transport.sendMail(mailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: mailOpts.subject as string,
      text: mailOpts.text as string,
      aampHeaders,
      messageId: info.messageId,
      inReplyTo: opts.inReplyTo,
      references: opts.inReplyTo,
    })
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
