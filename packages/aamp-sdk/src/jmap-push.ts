/**
 * JMAP WebSocket Push Client
 *
 * Connects to Stalwart's JMAP WebSocket endpoint and subscribes to
 * Email StateChange events. When a new email arrives in the agent's
 * mailbox, fetches it via JMAP and emits the parsed AAMP headers.
 *
 * Protocol: RFC 8887 (JMAP over WebSocket)
 * Ref: https://www.rfc-editor.org/rfc/rfc8887
 */

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { parseAampHeaders } from './parser.js'
import type { AampMessage, HumanReply } from './types.js'

interface JmapSession {
  capabilities: Record<string, unknown>
  accounts: Record<string, { name: string; isPrimary: boolean; accountCapabilities: Record<string, unknown> }>
  primaryAccounts: Record<string, string>
  username: string
  apiUrl: string
  downloadUrl: string
  uploadUrl: string
  eventSourceUrl: string
  state: string
}

interface JmapStateChange {
  '@type': 'StateChange'
  changed: Record<string, Record<string, string>>
  pushState?: string
}

interface JmapEmail {
  id: string
  blobId: string
  threadId: string
  mailboxIds: Record<string, boolean>
  subject: string
  from: Array<{ email: string; name?: string }>
  to: Array<{ email: string; name?: string }>
  replyTo?: Array<{ email: string; name?: string }>
  messageId?: string[]
  headers: Array<{ name: string; value: string }>
  receivedAt: string
  size: number
  /** Plain-text body parts (JMAP bodyStructure) */
  textBody?: Array<{ partId: string; type: string }>
  /** Decoded body values keyed by partId */
  bodyValues?: Record<string, { value: string; isEncodingProblem?: boolean; isTruncated?: boolean }>
  /** JMAP attachments (non-inline parts) */
  attachments?: Array<{
    blobId: string
    type: string
    name: string | null
    size: number
  }>
}

interface JmapMethodResponse {
  methodResponses: Array<[string, Record<string, unknown>, string]>
}

export class JmapPushClient extends EventEmitter {
  private ws: WebSocket | null = null
  private session: JmapSession | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private readonly seenMessageIds = new Set<string>()
  private connected = false
  private pollingActive = false
  private running = false
  private connecting = false
  /** JMAP Email state — tracks processed position; null = not yet initialized */
  private emailState: string | null = null
  private readonly startedAtMs = Date.now()

  private readonly email: string
  private readonly password: string
  private readonly jmapUrl: string
  private readonly reconnectInterval: number
  private readonly rejectUnauthorized: boolean
  private readonly pingIntervalMs = 5000

  constructor(opts: {
    email: string
    password: string
    jmapUrl: string
    reconnectInterval?: number
    /** Whether to reject unauthorized TLS certificates (default: true) */
    rejectUnauthorized?: boolean
  }) {
    super()
    this.email = opts.email
    this.password = opts.password
    this.jmapUrl = opts.jmapUrl.replace(/\/$/, '')
    this.reconnectInterval = opts.reconnectInterval ?? 5000
    this.rejectUnauthorized = opts.rejectUnauthorized ?? true
  }

  /**
   * Start the JMAP Push listener
   */
  async start(): Promise<void> {
    this.running = true
    await this.connect()
  }

  /**
   * Stop the JMAP Push listener
   */
  stop(): void {
    this.running = false
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.connected = false
    this.pollingActive = false
    this.connecting = false
  }

  private getAuthHeader(): string {
    const creds = `${this.email}:${this.password}`
    return `Basic ${Buffer.from(creds).toString('base64')}`
  }

  /**
   * Fetch the JMAP session object
   */
  private async fetchSession(): Promise<JmapSession> {
    const url = `${this.jmapUrl}/.well-known/jmap`
    const res = await fetch(url, {
      headers: { Authorization: this.getAuthHeader() },
    })

    if (!res.ok) {
      throw new Error(`Failed to fetch JMAP session: ${res.status} ${res.statusText}`)
    }

    return res.json() as Promise<JmapSession>
  }

  /**
   * Perform a JMAP API call
   */
  private async jmapCall(
    methods: Array<[string, Record<string, unknown>, string]>,
  ): Promise<JmapMethodResponse> {
    if (!this.session) throw new Error('No JMAP session')

    // Use the configured jmapUrl (external hostname) rather than session.apiUrl
    // which Stalwart populates with its own internal URL (e.g. http://aamp.local:8080/jmap)
    // and is unreachable when running behind a proxy.
    const apiUrl = `${this.jmapUrl}/jmap/`
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        Authorization: this.getAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        using: [
          'urn:ietf:params:jmap:core',
          'urn:ietf:params:jmap:mail',
        ],
        methodCalls: methods,
      }),
    })

    if (!res.ok) {
      throw new Error(`JMAP API call failed: ${res.status}`)
    }

    return res.json() as Promise<JmapMethodResponse>
  }

  /**
   * Initialize emailState by fetching the current state without loading any emails.
   * Called on first connect so we only process emails that arrive AFTER this point.
   */
  private async initEmailState(accountId: string): Promise<void> {
    const response = await this.jmapCall([
      ['Email/get', { accountId, ids: [] }, 'g0'],
    ])
    const getResp = response.methodResponses.find(([name]) => name === 'Email/get')
    if (getResp) {
      this.emailState = (getResp[1] as { state?: string }).state ?? null
    }
  }

  /**
   * Fetch only emails created since `sinceState` using Email/changes.
   * Updates `this.emailState` to the new state after fetching.
   * Returns [] and resets state if the server cannot calculate changes (state too old).
   */
  private async fetchEmailsSince(accountId: string, sinceState: string): Promise<JmapEmail[]> {
    const changesResp = await this.jmapCall([
      ['Email/changes', { accountId, sinceState, maxChanges: 50 }, 'c1'],
    ])

    const changesResult = changesResp.methodResponses.find(([name]) => name === 'Email/changes')

    // Handle server error — e.g. "cannotCalculateChanges" when state is too old
    if (!changesResult || changesResult[0] === 'error') {
      await this.initEmailState(accountId)
      return []
    }

    const changes = changesResult[1] as {
      created?: string[]
      newState?: string
      hasMoreChanges?: boolean
    }

    if (changes.newState) {
      this.emailState = changes.newState
    }

    const newIds = changes.created ?? []
    if (newIds.length === 0) return []

    const emailResp = await this.jmapCall([
      [
        'Email/get',
        {
          accountId,
          ids: newIds,
          properties: ['id', 'subject', 'from', 'to', 'headers', 'messageId', 'receivedAt', 'textBody', 'bodyValues', 'attachments'],
          fetchTextBodyValues: true,
          maxBodyValueBytes: 262144,
        },
        'g1',
      ],
    ])

    const getResult = emailResp.methodResponses.find(([name]) => name === 'Email/get')
    if (!getResult) return []

    const data = getResult[1] as { list?: JmapEmail[] }
    return data.list ?? []
  }

  /**
   * Process a received email.
   *
   * Priority:
   * 1. If X-AAMP-Intent is present → emit typed AAMP event (task.dispatch / task.result / task.help)
   * 2. If In-Reply-To is present → emit 'reply' event so the application layer can
   *    resolve the thread (inReplyTo → taskId via Redis/DB) and handle human replies.
   * 3. Otherwise → ignore (not an AAMP-related email)
   */
  private processEmail(email: JmapEmail): void {
    // Build lowercase header map from JMAP header array
    const headerMap: Record<string, string> = {}
    for (const h of email.headers ?? []) {
      headerMap[h.name.toLowerCase()] = h.value.trim()
    }

    const fromAddr = email.from?.[0]?.email ?? ''
    const toAddr = email.to?.[0]?.email ?? ''
    const messageId = email.messageId?.[0] ?? email.id

    if (this.seenMessageIds.has(messageId)) return
    this.seenMessageIds.add(messageId)

    // ── Path 1: AAMP-tagged email ─────────────────────────────────────────────
    const msg: AampMessage | null = parseAampHeaders({
      from: fromAddr,
      to: toAddr,
      messageId,
      subject: email.subject ?? '',
      headers: headerMap,
    })

    if (msg && 'intent' in msg) {
      // Attach email body text (task description) to all AAMP messages
      const aampTextPartId = email.textBody?.[0]?.partId
      const aampBodyText = aampTextPartId ? (email.bodyValues?.[aampTextPartId]?.value ?? '').trim() : ''
      ;(msg as unknown as Record<string, unknown>).bodyText = aampBodyText

      // Attach received attachment metadata (blobId-based, downloadable via downloadBlob)
      const receivedAttachments = (email.attachments ?? []).map(a => ({
        filename: a.name ?? 'attachment',
        contentType: a.type,
        size: a.size,
        blobId: a.blobId,
      }))
      if (receivedAttachments.length > 0) {
        ;(msg as unknown as Record<string, unknown>).attachments = receivedAttachments
      }

      // Auto-ACK for dispatches — AampClient handles the actual sending
      if ((msg as { intent: string }).intent === 'task.dispatch') {
        this.emit('_autoAck', { to: fromAddr, taskId: (msg as { taskId: string }).taskId, messageId })
      }

      this.emit((msg as { intent: string }).intent, msg)
      return
    }

    // ── Path 2: standard email reply — In-Reply-To fallback ───────────────────
    // Standard email clients automatically set In-Reply-To when replying.
    // We strip angle brackets (<msgid@host>) to get the bare Message-ID.
    const rawInReplyTo = headerMap['in-reply-to'] ?? ''
    if (!rawInReplyTo) return  // unrelated email, ignore

    // Handle "References" chain: prefer the last (most recent) Message-ID
    // so multi-turn threads still resolve to the correct task.
    const rawReferences = headerMap['references'] ?? ''
    const referencesIds = rawReferences
      .split(/\s+/)
      .map((s) => s.replace(/[<>]/g, '').trim())
      .filter(Boolean)

    const inReplyTo = rawInReplyTo.replace(/[<>]/g, '').trim()

    // Extract plain-text body if available (fetched via fetchTextBodyValues)
    const textPartId = email.textBody?.[0]?.partId
    const bodyText = textPartId ? (email.bodyValues?.[textPartId]?.value ?? '').trim() : ''

    const reply: HumanReply = {
      inReplyTo,
      messageId,
      from: fromAddr,
      to: toAddr,
      subject: email.subject ?? '',
      bodyText,
    }

    // Also expose the full References chain so callers can walk the thread if needed
    if (referencesIds.length > 0) {
      Object.assign(reply, { references: referencesIds })
    }

    this.emit('reply', reply)
  }

  private async fetchRecentEmails(accountId: string): Promise<JmapEmail[]> {
    const queryResp = await this.jmapCall([
      [
        'Email/query',
        {
          accountId,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit: 20,
        },
        'q1',
      ],
    ])

    const queryResult = queryResp.methodResponses.find(([name]) => name === 'Email/query')
    if (!queryResult) return []

    const ids = ((queryResult[1] as { ids?: string[] }).ids ?? []).slice(0, 20)
    if (ids.length === 0) return []

    const emailResp = await this.jmapCall([
      [
        'Email/get',
        {
          accountId,
          ids,
          properties: ['id', 'subject', 'from', 'to', 'headers', 'messageId', 'receivedAt', 'textBody', 'bodyValues', 'attachments'],
          fetchTextBodyValues: true,
          maxBodyValueBytes: 262144,
        },
        'gRecent',
      ],
    ])

    const getResult = emailResp.methodResponses.find(([name]) => name === 'Email/get')
    if (!getResult) return []

    return (getResult[1] as { list?: JmapEmail[] }).list ?? []
  }

  private shouldProcessBootstrapEmail(email: JmapEmail): boolean {
    const receivedAtMs = new Date(email.receivedAt).getTime()
    // Keep a small grace window for mail that arrived during startup / reconnect races,
    // but do not replay older historical mailbox contents as fresh tasks.
    return Number.isFinite(receivedAtMs) && receivedAtMs >= this.startedAtMs - 15_000
  }

  /**
   * Connect to JMAP WebSocket
   */
  private async connect(): Promise<void> {
    if (this.connecting || !this.running) return
    this.connecting = true

    try {
      this.session = await this.fetchSession()
    } catch (err) {
      this.connecting = false
      this.emit('error', new Error(`Failed to get JMAP session: ${(err as Error).message}`))
      this.startPolling('session fetch failed')
      this.scheduleReconnect()
      return
    }

    // Build WebSocket URL from the configured jmapUrl (the management-service proxy).
    // The management service exposes the standard external WebSocket path /jmap/ws
    // and proxies upgrades to Stalwart. We never use the session capability URL
    // directly because Stalwart populates it with its own internal hostname
    // (e.g. ws://aamp.local:8080/jmap/ws), which is unreachable from outside
    // the Docker / cluster network.
    const stalwartWsUrl = `${this.jmapUrl}/jmap/ws`
      .replace(/^https:\/\//, 'wss://')
      .replace(/^http:\/\//, 'ws://')

    this.ws = new WebSocket(stalwartWsUrl, 'jmap', {
      headers: {
        Authorization: this.getAuthHeader(),
      },
      perMessageDeflate: false,
      rejectUnauthorized: this.rejectUnauthorized,
    })

    this.ws.on('unexpected-response', (_req, res) => {
      this.connecting = false
      const headerSummary = Object.entries(res.headers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : (value ?? '')}`)
        .join('; ')
      this.startPolling(`websocket handshake failed: ${res.statusCode ?? 'unknown'}`)
      this.emit(
        'error',
        new Error(
          `JMAP WebSocket handshake failed: ${res.statusCode ?? 'unknown'} ${res.statusMessage ?? ''}${headerSummary ? ` | headers: ${headerSummary}` : ''}`,
        ),
      )
      this.scheduleReconnect()
    })

    this.ws.on('open', async () => {
      this.connecting = false
      this.connected = true
      this.stopPolling()
      this.startPingHeartbeat()

      // On first connect (emailState is null), initialize state so we only
      // process emails arriving AFTER this point.
      // On reconnect, emailState is already set — Email/changes will catch up.
      const accountId = this.session?.primaryAccounts['urn:ietf:params:jmap:mail']
      if (accountId && this.emailState === null) {
        await this.initEmailState(accountId)
      }

      // Subscribe to Email state changes AFTER state is initialized
      this.ws!.send(
        JSON.stringify({
          '@type': 'WebSocketPushEnable',
          dataTypes: ['Email'],
          pushState: null,
        }),
      )

      this.emit('connected')
    })

    this.ws.on('pong', () => {
      // Receiving pong confirms the upstream and LB path are still alive.
    })

    this.ws.on('message', async (rawData: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as {
          '@type': string
        } & JmapStateChange

        if (msg['@type'] === 'StateChange') {
          await this.handleStateChange(msg)
        }
      } catch (err) {
        this.emit('error', new Error(`Failed to process JMAP push message: ${(err as Error).message}`))
      }
    })

    this.ws.on('close', (code, reason) => {
      this.connecting = false
      this.connected = false
      this.stopPingHeartbeat()
      const reasonStr = reason?.toString() ?? 'connection closed'
      this.startPolling(reasonStr)
      this.emit('disconnected', reasonStr)

      if (this.running) {
        this.scheduleReconnect()
      }
    })

    this.ws.on('error', (err) => {
      this.connecting = false
      this.stopPingHeartbeat()
      this.startPolling(err.message)
      this.emit('error', err)
    })
  }

  private startPingHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      try {
        this.ws.ping()
      } catch (err) {
        this.emit('error', new Error(`Failed to send WebSocket ping: ${(err as Error).message}`))
      }
    }, this.pingIntervalMs)
  }

  private stopPingHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private async handleStateChange(stateChange: JmapStateChange): Promise<void> {
    if (!this.session) return

    const accountId = this.session.primaryAccounts['urn:ietf:params:jmap:mail']
    if (!accountId) return

    const changedAccount = stateChange.changed[accountId]
    if (!changedAccount?.Email) return

    try {
      if (this.emailState === null) {
        // State not yet initialized (race between open handler and first StateChange)
        // Just initialize and skip — next StateChange will use Email/changes properly
        await this.initEmailState(accountId)
        return
      }

      const emails = await this.fetchEmailsSince(accountId, this.emailState)
      for (const email of emails) {
        this.processEmail(email)
      }
    } catch (err) {
      this.emit('error', new Error(`Failed to fetch emails: ${(err as Error).message}`))
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null
      if (this.running) {
        await this.connect()
      }
    }, this.reconnectInterval)
  }

  isConnected(): boolean {
    return this.connected || this.pollingActive
  }

  isUsingPollingFallback(): boolean {
    return this.pollingActive && !this.connected
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    this.pollingActive = false
  }

  private startPolling(reason: string): void {
    if (!this.running || this.pollingActive) return

    this.pollingActive = true
    this.emit('error', new Error(`JMAP WebSocket unavailable, falling back to polling: ${reason}`))
    this.emit('connected')

    const poll = async () => {
      if (!this.running || this.connected) {
        this.stopPolling()
        return
      }

      try {
        if (!this.session) {
          this.session = await this.fetchSession()
        }

        const accountId = this.session.primaryAccounts['urn:ietf:params:jmap:mail']
          ?? Object.keys(this.session.accounts)[0]

        if (!accountId) {
          throw new Error('No mail account available in JMAP session')
        }

        if (this.emailState === null) {
          const recentEmails = await this.fetchRecentEmails(accountId)
          for (const email of recentEmails.sort((a, b) => {
            const aTs = new Date(a.receivedAt).getTime()
            const bTs = new Date(b.receivedAt).getTime()
            return aTs - bTs
          })) {
            if (!this.shouldProcessBootstrapEmail(email)) continue
            this.processEmail(email)
          }
          await this.initEmailState(accountId)
        } else {
          const emails = await this.fetchEmailsSince(accountId, this.emailState)
          for (const email of emails) {
            this.processEmail(email)
          }
        }
      } catch (err) {
        this.emit('error', new Error(`Polling fallback failed: ${(err as Error).message}`))
      } finally {
        if (this.running && !this.connected) {
          this.pollTimer = setTimeout(poll, this.reconnectInterval)
        }
      }
    }

    this.pollTimer = setTimeout(poll, 0)
  }

  /**
   * Download a blob (attachment) by its JMAP blobId.
   * Returns the raw binary content as a Buffer.
   */
  async downloadBlob(blobId: string, filename?: string): Promise<Buffer> {
    if (!this.session) {
      // Fetch session on demand if not yet connected
      this.session = await this.fetchSession()
    }

    const accountId = this.session.primaryAccounts['urn:ietf:params:jmap:mail']
      ?? Object.keys(this.session.accounts)[0]

    // Build download URL from session template or fall back to standard JMAP path
    let downloadUrl = this.session.downloadUrl
      ?? `${this.jmapUrl}/jmap/download/{accountId}/{blobId}/{name}`

    // Replace session.downloadUrl host with our configured jmapUrl
    // (Stalwart may report an internal hostname unreachable from outside Docker)
    try {
      const parsed = new URL(downloadUrl)
      const configured = new URL(this.jmapUrl)
      parsed.protocol = configured.protocol
      parsed.host = configured.host
      downloadUrl = parsed.toString()
    } catch {
      // If URL parsing fails, use the template as-is
    }

    const safeFilename = filename ?? 'attachment'
    downloadUrl = downloadUrl
      .replace(/\{accountId\}|%7BaccountId%7D/gi, encodeURIComponent(accountId))
      .replace(/\{blobId\}|%7BblobId%7D/gi, encodeURIComponent(blobId))
      .replace(/\{name\}|%7Bname%7D/gi, encodeURIComponent(safeFilename))
      .replace(/\{type\}|%7Btype%7D/gi, 'application/octet-stream')

    // Retry with exponential backoff — the blob may not be immediately available
    // after the result email is observed (store/index write delay).
    const maxAttempts = 8
    let lastStatus: number | null = null
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(downloadUrl, {
        headers: { Authorization: this.getAuthHeader() },
      })
      lastStatus = res.status
      if (res.ok) {
        const arrayBuffer = await res.arrayBuffer()
        return Buffer.from(arrayBuffer)
      }
      if (attempt < maxAttempts && (res.status === 404 || res.status === 429 || res.status === 503)) {
        console.warn(
          `[AAMP-SDK] blob download retry status=${res.status} attempt=${attempt}/${maxAttempts} url=${downloadUrl}`,
        )
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 15000) // 1s, 2s, 4s, 8s, 15s...
        await new Promise(r => setTimeout(r, delay))
        continue
      }
      console.error(
        `[AAMP-SDK] blob download failed status=${res.status} attempt=${attempt}/${maxAttempts} url=${downloadUrl}`,
      )
      throw new Error(
        `Blob download failed: status=${res.status} attempt=${attempt}/${maxAttempts} blobId=${blobId} filename=${filename ?? 'attachment'} url=${downloadUrl}`,
      )
    }
    throw new Error(
      `Blob download failed after retries: status=${lastStatus ?? 'unknown'} attempt=${maxAttempts}/${maxAttempts} blobId=${blobId} filename=${filename ?? 'attachment'} url=${downloadUrl}`,
    )
  }

  /**
   * Actively reconcile recent mailbox contents via JMAP HTTP.
   * Useful as a safety net when the WebSocket stays "connected"
   * but a notification is missed by an intermediate layer.
   */
  async reconcileRecentEmails(limit = 20): Promise<number> {
    if (!this.session) {
      this.session = await this.fetchSession()
    }

    const accountId = this.session.primaryAccounts['urn:ietf:params:jmap:mail']
      ?? Object.keys(this.session.accounts)[0]

    if (!accountId) {
      throw new Error('No mail account available in JMAP session')
    }

    const queryResp = await this.jmapCall([
      [
        'Email/query',
        {
          accountId,
          sort: [{ property: 'receivedAt', isAscending: false }],
          limit,
        },
        'qReconcile',
      ],
    ])

    const queryResult = queryResp.methodResponses.find(([name]) => name === 'Email/query')
    if (!queryResult) return 0

    const ids = ((queryResult[1] as { ids?: string[] }).ids ?? []).slice(0, limit)
    if (ids.length === 0) return 0

    const emailResp = await this.jmapCall([
      [
        'Email/get',
        {
          accountId,
          ids,
          properties: ['id', 'subject', 'from', 'to', 'headers', 'messageId', 'receivedAt', 'textBody', 'bodyValues', 'attachments'],
          fetchTextBodyValues: true,
          maxBodyValueBytes: 262144,
        },
        'gReconcile',
      ],
    ])

    const getResult = emailResp.methodResponses.find(([name]) => name === 'Email/get')
    if (!getResult) return 0

    const emails = (getResult[1] as { list?: JmapEmail[] }).list ?? []
    for (const email of emails.sort((a, b) => {
      const aTs = new Date(a.receivedAt).getTime()
      const bTs = new Date(b.receivedAt).getTime()
      return aTs - bTs
    })) {
      if (!this.shouldProcessBootstrapEmail(email)) continue
      this.processEmail(email)
    }

    return emails.length
  }
}
