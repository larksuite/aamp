/**
 * SMTP Sender
 *
 * Sends AAMP protocol emails via SMTP (Stalwart submission port 587).
 */

import { createTransport, type Transporter } from 'nodemailer'
import { randomUUID } from 'crypto'

/** Strip CR/LF to prevent email header injection */
const sanitize = (s: string) => s.replace(/[\r\n]/g, ' ').trim()

const HTTP_SEND_MAX_ATTEMPTS = 4
const HTTP_SEND_RETRY_BASE_DELAY_MS = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500
}

function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const details = err as Error & { code?: string; cause?: unknown }
  const parts = [err.message]
  if (details.code) parts.push(`code=${details.code}`)
  if (details.cause instanceof Error) parts.push(`cause=${describeError(details.cause)}`)
  return parts.join(' | ')
}
import {
  buildDispatchHeaders,
  buildCancelHeaders,
  buildResultHeaders,
  buildHelpHeaders,
  buildAckHeaders,
  buildStreamOpenedHeaders,
  buildPairRequestHeaders,
  buildPairRespondHeaders,
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
  AampFetch,
  SendPairRequestOptions,
  SendPairRespondOptions,
} from './types.js'

export interface SmtpConfig {
  host: string
  port: number
  user: string
  password: string
  httpBaseUrl?: string
  authToken?: string
  fetch?: AampFetch
  forceHttpSend?: boolean
  persistSentCopy?: boolean
  secure?: boolean
  /** Whether to reject unauthorized TLS certificates (default: true) */
  rejectUnauthorized?: boolean
}

export interface MailboxIdentityConfig {
  email: string
  password: string
  baseUrl?: string
  smtpPort?: number
  fetch?: AampFetch
  forceHttpSend?: boolean
  persistSentCopy?: boolean
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
  private readonly fetch: AampFetch
  private discoveredApiUrlPromise: Promise<string> | null = null
  private jmapSessionPromise: Promise<{
    accountId: string
    apiUrl: string
    uploadUrl: string
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
      fetch: config.fetch,
      forceHttpSend: config.forceHttpSend,
      persistSentCopy: config.persistSentCopy,
      secure: config.secure,
      rejectUnauthorized: config.rejectUnauthorized,
    })
  }

  constructor(private readonly config: SmtpConfig) {
    this.fetch = config.fetch ?? fetch
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
    if (this.config.forceHttpSend) {
      return Boolean(this.config.httpBaseUrl && this.config.authToken)
    }
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
        const discoveryRes = await this.fetch(`${base}/.well-known/aamp`)
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

    let lastError: Error | null = null
    for (let attempt = 1; attempt <= HTTP_SEND_MAX_ATTEMPTS; attempt += 1) {
      const apiUrl = new URL(await this.resolveAampApiUrl())
      apiUrl.searchParams.set('action', 'aamp.mailbox.send')

      try {
        const res = await this.fetch(apiUrl, {
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
        if (res.ok) return { messageId: data.messageId }

        lastError = new Error(data.details || `HTTP send failed: ${res.status}`)
        if (!isRetryableHttpStatus(res.status) || attempt === HTTP_SEND_MAX_ATTEMPTS) break
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))
        if (attempt === HTTP_SEND_MAX_ATTEMPTS) {
          lastError = new Error(`HTTP send failed after ${attempt} attempts: ${describeError(lastError)}`)
          break
        }
      }

      await sleep(HTTP_SEND_RETRY_BASE_DELAY_MS * attempt)
    }

    throw lastError ?? new Error('HTTP send failed')
  }

  private canPersistSentCopy(): boolean {
    if (this.config.persistSentCopy === false) return false
    return Boolean(this.config.httpBaseUrl && this.config.authToken)
  }

  private normalizeAttachments(
    attachments?: Array<{ filename: string; contentType: string; content: Buffer | string }>,
  ): Array<{ filename: string; contentType: string; content: Buffer }> | undefined {
    if (!attachments?.length) return undefined
    return attachments.map(a => ({
      filename: a.filename,
      contentType: a.contentType,
      content: typeof a.content === 'string' ? Buffer.from(a.content, 'base64') : a.content,
    }))
  }

  private getJmapAuthHeader(): string {
    if (!this.config.authToken) {
      throw new Error('JMAP auth token is not configured')
    }
    return `Basic ${this.config.authToken}`
  }

  private rewriteUrlToConfiguredOrigin(rawUrl: string): string {
    const base = this.config.httpBaseUrl?.replace(/\/$/, '')
    if (!base) return rawUrl

    const parsed = new URL(rawUrl, `${base}/`)
    const configured = new URL(base)
    parsed.protocol = configured.protocol
    parsed.username = configured.username
    parsed.password = configured.password
    parsed.hostname = configured.hostname
    parsed.port = configured.port
    return parsed.toString()
  }

  private async resolveJmapSession(): Promise<{ accountId: string; apiUrl: string; uploadUrl: string }> {
    const base = this.config.httpBaseUrl?.replace(/\/$/, '')
    if (!base) {
      throw new Error('JMAP base URL is not configured')
    }

    if (!this.jmapSessionPromise) {
      this.jmapSessionPromise = (async () => {
        const res = await this.fetch(`${base}/.well-known/jmap`, {
          headers: { Authorization: this.getJmapAuthHeader() },
        })
        if (!res.ok) {
          throw new Error(`JMAP session failed: ${res.status} ${res.statusText}`)
        }

        const session = await res.json() as {
          accounts?: Record<string, unknown>
          primaryAccounts?: Record<string, string>
          uploadUrl?: string
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
          uploadUrl: this.rewriteUrlToConfiguredOrigin(
            session.uploadUrl ?? `${base}/jmap/upload/{accountId}/`,
          ),
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
    const res = await this.fetch(session.apiUrl, {
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

  private async uploadJmapBlob(params: {
    content: Buffer
    contentType: string
  }): Promise<{
    blobId: string
    type: string
    size: number
  }> {
    const session = await this.resolveJmapSession()
    const uploadUrl = session.uploadUrl
      .replace(/\{accountId\}|%7BaccountId%7D/gi, encodeURIComponent(session.accountId))

    const res = await this.fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: this.getJmapAuthHeader(),
        'Content-Type': params.contentType,
      },
      body: params.content as unknown as BodyInit,
    })

    const bodyText = await res.text()
    if (!res.ok) {
      throw new Error(`JMAP blob upload failed: ${res.status} ${bodyText}`)
    }

    let data: { blobId?: string; type?: string; size?: number }
    try {
      data = JSON.parse(bodyText) as { blobId?: string; type?: string; size?: number }
    } catch {
      throw new Error('JMAP blob upload returned invalid JSON')
    }
    if (!data.blobId) {
      throw new Error('JMAP blob upload did not return blobId')
    }

    return {
      blobId: data.blobId,
      type: data.type ?? params.contentType,
      size: data.size ?? params.content.byteLength,
    }
  }

  private async buildRawSentMessage(params: {
    from: string
    to: string
    subject: string
    text: string
    aampHeaders: Record<string, string>
    messageId?: string
    inReplyTo?: string
    references?: string
    attachments?: Array<{ filename: string; contentType: string; content: Buffer | string }>
  }): Promise<Buffer> {
    const rawTransport = createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    } as Parameters<typeof createTransport>[0])

    const mailOptions: Record<string, unknown> = {
      from: params.from,
      to: params.to,
      subject: params.subject,
      text: params.text,
      headers: params.aampHeaders,
    }
    if (params.messageId) mailOptions.messageId = sanitize(params.messageId)
    if (params.inReplyTo) mailOptions.inReplyTo = params.inReplyTo
    if (params.references) mailOptions.references = params.references
    if (params.attachments?.length) {
      mailOptions.attachments = params.attachments.map((attachment) => ({
        filename: attachment.filename,
        contentType: attachment.contentType,
        content: typeof attachment.content === 'string'
          ? Buffer.from(attachment.content, 'base64')
          : attachment.content,
      }))
    }

    const info = await rawTransport.sendMail(mailOptions)
    const rawMessage = (info as { message?: unknown }).message
    if (Buffer.isBuffer(rawMessage)) return rawMessage
    if (rawMessage instanceof Uint8Array) return Buffer.from(rawMessage)
    if (typeof rawMessage === 'string') return Buffer.from(rawMessage)
    throw new Error('Raw message generation did not return a Buffer')
  }

  private async importRawSentMessage(params: {
    from: string
    to: string
    subject: string
    text: string
    aampHeaders: Record<string, string>
    messageId?: string
    inReplyTo?: string
    references?: string
    attachments?: Array<{ filename: string; contentType: string; content: Buffer | string }>
  }): Promise<void> {
    if (!this.canPersistSentCopy()) return

    const sentMailboxId = await this.getSentMailboxId()
    if (!sentMailboxId) return

    const rawMessage = await this.buildRawSentMessage(params)
    const uploadedMessage = await this.uploadJmapBlob({
      content: rawMessage,
      contentType: 'message/rfc822',
    })
    const responses = await this.jmapCall([
      [
        'Email/import',
        {
          emails: {
            sent1: {
              blobId: uploadedMessage.blobId,
              mailboxIds: { [sentMailboxId]: true },
              keywords: { '$seen': true },
            },
          },
        },
        'import1',
      ],
    ])
    const result = responses.find(([name]) => name === 'Email/import')?.[1] as
      | { imported?: Record<string, unknown>; notImported?: Record<string, unknown> }
      | undefined
    if (result?.notImported?.sent1) {
      throw new Error(`JMAP sent message import failed: ${JSON.stringify(result.notImported.sent1)}`)
    }
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
    attachments?: Array<{ filename: string; contentType: string; content: Buffer | string }>
  }): Promise<void> {
    if (!this.canPersistSentCopy()) return

    if (params.attachments?.length) {
      await this.importRawSentMessage(params)
      return
    }

    const sentMailboxId = await this.getSentMailboxId()
    if (!sentMailboxId) return

    const emailCreate: Record<string, unknown> = {
      mailboxIds: { [sentMailboxId]: true },
      from: [{ email: params.from }],
      to: [{ email: params.to }],
      subject: params.subject,
      keywords: { '$seen': true },
    }

    emailCreate.bodyValues = {
      body: {
        value: params.text,
        charset: 'utf-8',
      },
    }
    emailCreate.textBody = [{ partId: 'body', type: 'text/plain' }]

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
    attachments?: Array<{ filename: string; contentType: string; content: Buffer | string }>
  }): Promise<void> {
    if (!this.canPersistSentCopy()) return
    try {
      await this.saveToSent(params)
    } catch {
      if (params.attachments?.length) {
        try {
          await this.saveToSent({ ...params, attachments: undefined })
        } catch { /* non-fatal */ }
      }
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
    const attachments = this.normalizeAttachments(opts.attachments)
    const aampHeaders = buildDispatchHeaders({
      taskId,
      priority: opts.priority,
      expiresAt: opts.expiresAt,
      sessionKey: opts.sessionKey,
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

    if (attachments) {
      sendMailOpts.attachments = attachments
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: sendMailOpts.subject as string,
        text: sendMailOpts.text as string,
        aampHeaders,
        attachments,
      })
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: sendMailOpts.subject as string,
        text: sendMailOpts.text as string,
        aampHeaders,
        messageId: info.messageId,
        attachments,
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
      attachments,
    })

    return { taskId, messageId: info.messageId ?? '' }
  }

  /**
   * Send a task.result email back to the dispatcher
   */
  async sendResult(opts: SendResultOptions): Promise<void> {
    const attachments = this.normalizeAttachments(opts.attachments)
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
    if (attachments) {
      mailOpts.attachments = attachments
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text: mailOpts.text as string,
        aampHeaders,
        attachments,
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
        attachments,
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
      attachments,
    })
  }

  /**
   * Send a task.help_needed email when the agent is blocked
   */
  async sendHelp(opts: SendHelpOptions): Promise<void> {
    const attachments = this.normalizeAttachments(opts.attachments)
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
    if (attachments) {
      helpMailOpts.attachments = attachments
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: helpMailOpts.subject as string,
        text: helpMailOpts.text as string,
        aampHeaders,
        attachments,
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
        attachments,
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
      attachments,
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

  async sendPairRequest(opts: SendPairRequestOptions): Promise<{ taskId: string; messageId: string }> {
    const taskId = opts.taskId ?? randomUUID()
    const aampHeaders = buildPairRequestHeaders({
      taskId,
      pairCode: opts.pairCode,
      dispatchContextRules: opts.dispatchContextRules ?? {},
    })
    const text = [
      'AAMP Pair Request',
      '',
      `Pair code: ${opts.pairCode}`,
      `Dispatch context rules: ${JSON.stringify(opts.dispatchContextRules ?? {})}`,
    ].join('\n')
    const mailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: '[AAMP Pair] Connection request',
      text,
      headers: aampHeaders,
    }

    if (this.shouldUseHttpFallback(opts.to)) {
      const info = await this.sendViaHttp({
        to: opts.to,
        subject: mailOpts.subject as string,
        text,
        aampHeaders,
      })
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: mailOpts.subject as string,
        text,
        aampHeaders,
        messageId: info.messageId,
      })
      return { taskId, messageId: info.messageId ?? '' }
    }

    const info = await this.transport.sendMail(mailOpts)
    await this.saveToSentBestEffort({
      from: this.config.user,
      to: opts.to,
      subject: mailOpts.subject as string,
      text,
      aampHeaders,
      messageId: info.messageId,
    })
    return { taskId, messageId: info.messageId ?? '' }
  }

  async sendPairRespond(opts: SendPairRespondOptions): Promise<void> {
    const aampHeaders = buildPairRespondHeaders({
      taskId: opts.taskId,
      success: opts.success,
      reason: opts.reason,
    })
    const status = opts.success ? 'completed' : 'rejected'
    const text = [
      'AAMP Pair Response',
      '',
      `Task ID: ${opts.taskId}`,
      `Status: ${status}`,
      ...(opts.reason?.trim() ? ['', `Reason: ${opts.reason.trim()}`] : []),
    ].join('\n')
    const mailOpts: Record<string, unknown> = {
      from: this.config.user,
      to: opts.to,
      subject: `[AAMP Pair] ${status}`,
      text,
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
        text,
        aampHeaders,
      })
      await this.saveToSentBestEffort({
        from: this.config.user,
        to: opts.to,
        subject: mailOpts.subject as string,
        text,
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
      text,
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
