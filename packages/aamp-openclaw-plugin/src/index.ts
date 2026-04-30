/**
 * @aamp/openclaw-plugin
 *
 * OpenClaw plugin that gives the agent an AAMP mailbox identity and lets it
 * receive, process, and reply to AAMP tasks — entirely through standard email.
 *
 * How it works:
 *   1. Plugin resolves or auto-registers an AAMP mailbox identity on startup.
 *   2. Credentials are cached to a local file so the same mailbox is reused
 *      across gateway restarts (no re-registration needed).
 *   3. Background JMAP WebSocket Push receives incoming task.dispatch emails.
 *   4. Incoming tasks are stored in an in-memory pending-task queue.
 *   5. before_prompt_build injects the oldest pending task into the LLM's
 *      system context so the agent sees it and acts without user prompting.
 *   6. The agent calls aamp_send_result or aamp_send_help to reply.
 *
 * OpenClaw config (openclaw.json):
 *
 *   "plugins": {
 *     "entries": {
 *       "aamp": {
 *         "enabled": true,
 *         "config": {
 *           "aampHost":        "https://meshmail.ai",
 *           "slug":            "openclaw-agent",
 *           "credentialsFile": "/absolute/path/to/.aamp-credentials.json"
 *         }
 *       }
 *     }
 *   }
 *
 * Install:
 *   openclaw plugins install ./packages/aamp-openclaw-plugin
 */

import { AampClient } from 'aamp-sdk'
import type {
  AampThreadEvent,
  TaskDispatch,
  TaskCancel,
  TaskResult,
  TaskHelp,
  TaskPriority,
  AampAttachment,
  ReceivedAttachment,
} from 'aamp-sdk'
import { readFileSync } from 'node:fs'
import {
  defaultCredentialsPath,
  defaultTaskStatePath,
  ensureDir,
  loadCachedIdentity,
  loadTaskState,
  readBinaryFile,
  saveCachedIdentity,
  saveTaskState,
  writeBinaryFile,
  type Identity,
} from './file-store.js'

// ─── Shared runtime state (single instance per plugin lifetime) ───────────────

interface PendingTask {
  taskId: string
  from: string
  title: string
  bodyText: string
  threadHistory: AampThreadEvent[]
  threadContextText: string
  priority: TaskPriority
  expiresAt?: string
  contextLinks: string[]
  messageId: string
  receivedAt: string  // ISO-8601
}

interface PluginConfig {
  /** e.g. "meshmail.ai" — all URLs are derived from this */
  aampHost: string
  slug?: string
  summary?: string
  cardText?: string
  cardFile?: string
  /** Absolute path to cache AAMP credentials. Default: ~/.openclaw/extensions/aamp-openclaw-plugin/.credentials.json */
  credentialsFile?: string
  senderPolicies?: SenderPolicy[]
}

interface SenderPolicy {
  sender: string
  dispatchContextRules?: Record<string, string[]>
}

export function matchSenderPolicy(
  task: TaskDispatch,
  senderPolicies: SenderPolicy[] | undefined,
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

type StructuredResultFieldInput = {
  fieldKey: string
  fieldTypeKey: string
  fieldAlias?: string
  value?: unknown
  index?: string
  attachmentFilenames?: string[]
}

/** Normalise aampHost to a base URL with scheme and no trailing slash */
export function baseUrl(aampHost: string): string {
  if (aampHost.startsWith('http://') || aampHost.startsWith('https://')) {
    return aampHost.replace(/\/$/, '')
  }
  return `https://${aampHost}`
}

const pendingTasks = new Map<string, PendingTask>()
const activeTaskStreams = new Map<string, string>()
const terminalTaskIds = new Set<string>(loadTaskState(defaultTaskStatePath()).terminalTaskIds ?? [])
const AAMP_SESSION_PREFIX = 'aamp:'
const DEFAULT_OPENCLAW_AGENT_ID = 'main'
const OPENCLAW_AGENT_SESSION_PREFIX = 'agent:'
const VALID_OPENCLAW_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const INVALID_OPENCLAW_AGENT_ID_RE = /[^a-z0-9_-]+/g
const LEADING_DASH_RE = /^-+/
const TRAILING_DASH_RE = /-+$/
// Tracks sub-tasks dispatched TO other agents — waiting for their result/help replies
const dispatchedSubtasks = new Map<string, { to: string; title: string; dispatchedAt: string; parentTaskId?: string }>()
// Tracks notification keys that have been shown to LLM (auto-cleaned on next prompt build)
const shownNotifications = new Set<string>()
// Pending synchronous dispatch waiters — resolve callback keyed by sub-task ID.
// When aamp_dispatch_task sends a sub-task, it parks a Promise here and waits.
// When task.result/help arrives for that sub-task ID, the waiter is resolved
// directly, keeping the LLM awake with full context (no heartbeat needed).
const waitingDispatches = new Map<string, (reply: { type: 'result' | 'help'; data: unknown }) => void>()
let aampClient: AampClient | null = null
let agentEmail = ''
let lastConnectionError = ''
let lastDisconnectReason = ''
let lastTransportMode: 'disconnected' | 'websocket' | 'polling' = 'disconnected'
let lastLoggedTransportMode: 'disconnected' | 'websocket' | 'polling' = 'disconnected'
let reconcileTimer: NodeJS.Timeout | null = null
let transportMonitorTimer: NodeJS.Timeout | null = null
let historicalReconcileCompleted = false
// Channel runtime — captured from channel adapter's startAccount for instant dispatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channelRuntime: any = null
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let channelCfg: any = null

async function ensureTaskStream(task: PendingTask): Promise<string | null> {
  if (!aampClient?.isConnected()) return null
  const existing = activeTaskStreams.get(task.taskId)
  if (existing) return existing

  const created = await aampClient.createStream({
    taskId: task.taskId,
    peerEmail: task.from,
  })
  await aampClient.sendStreamOpened({
    to: task.from,
    taskId: task.taskId,
    streamId: created.streamId,
    inReplyTo: task.messageId || undefined,
  })
  await aampClient.appendStreamEvent({
    streamId: created.streamId,
    type: 'status',
    payload: { state: 'running', label: 'Task queued in OpenClaw' },
  })
  activeTaskStreams.set(task.taskId, created.streamId)
  return created.streamId
}

async function appendTaskStream(taskId: string, type: 'text.delta' | 'progress' | 'status' | 'artifact' | 'error' | 'done', payload: Record<string, unknown>): Promise<void> {
  if (!aampClient?.isConnected()) return
  const streamId = activeTaskStreams.get(taskId)
  if (!streamId) return
  await aampClient.appendStreamEvent({
    streamId,
    type,
    payload,
  })
}

async function closeTaskStream(taskId: string, payload?: Record<string, unknown>): Promise<void> {
  if (!aampClient?.isConnected()) return
  const streamId = activeTaskStreams.get(taskId)
  if (!streamId) return
  activeTaskStreams.delete(taskId)
  await aampClient.closeStream({
    streamId,
    payload,
  })
}

function logTransportState(
  api: { logger: { info: (msg: string) => void; warn: (msg: string) => void } },
  mode: 'websocket' | 'polling',
  email: string,
  previousMode: 'disconnected' | 'websocket' | 'polling',
): void {
  if (mode === previousMode) return

  if (mode === 'polling') {
    api.logger.info(`[AAMP] Connected (polling fallback active) — listening as ${email}`)
    return
  }

  if (previousMode === 'polling') {
    api.logger.info(`[AAMP] WebSocket restored — listening as ${email}`)
    return
  }

  api.logger.info(`[AAMP] Connected — listening as ${email}`)
}

function isSyntheticPendingKey(taskKey: string): boolean {
  return taskKey.startsWith('result:') || taskKey.startsWith('help:')
}

function normalizeOpenClawAgentId(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed) return DEFAULT_OPENCLAW_AGENT_ID
  if (VALID_OPENCLAW_AGENT_ID_RE.test(trimmed)) return trimmed.toLowerCase()
  return trimmed
    .toLowerCase()
    .replace(INVALID_OPENCLAW_AGENT_ID_RE, '-')
    .replace(LEADING_DASH_RE, '')
    .replace(TRAILING_DASH_RE, '')
    .slice(0, 64) || DEFAULT_OPENCLAW_AGENT_ID
}

function resolveDefaultOpenClawAgentId(config: unknown): string {
  const agents = (config as { agents?: { list?: Array<{ id?: unknown; default?: unknown }> } } | null | undefined)?.agents?.list
  if (!Array.isArray(agents) || agents.length === 0) return DEFAULT_OPENCLAW_AGENT_ID

  const defaults = agents.filter((agent) => agent?.default)
  return normalizeOpenClawAgentId((defaults[0] ?? agents[0])?.id)
}

function stripOpenClawAgentScope(sessionKey: string): string {
  const trimmed = sessionKey.trim()
  if (!trimmed.toLowerCase().startsWith(OPENCLAW_AGENT_SESSION_PREFIX)) return trimmed

  const parts = trimmed.split(':')
  if (parts.length < 3 || parts[0]?.toLowerCase() !== 'agent') return trimmed
  return parts.slice(2).join(':')
}

function isAampSessionKey(sessionKey: unknown): sessionKey is string {
  return typeof sessionKey === 'string'
    && stripOpenClawAgentScope(sessionKey).toLowerCase().startsWith(AAMP_SESSION_PREFIX)
}

function buildOpenClawMainSessionKey(mainKey: string, config: unknown): string {
  const trimmed = mainKey.trim()
  if (!trimmed) return `${OPENCLAW_AGENT_SESSION_PREFIX}${resolveDefaultOpenClawAgentId(config)}:main`
  if (trimmed.toLowerCase().startsWith(OPENCLAW_AGENT_SESSION_PREFIX)) return trimmed
  return `${OPENCLAW_AGENT_SESSION_PREFIX}${resolveDefaultOpenClawAgentId(config)}:${trimmed}`
}

function buildAampConversationSessionKey(value: string, config: unknown): string {
  return buildOpenClawMainSessionKey(`${AAMP_SESSION_PREFIX}default:${value}`, config)
}

function buildAampTaskSessionKey(taskId: string, config: unknown): string {
  return buildAampConversationSessionKey(`task:${taskId}`, config)
}

function buildAampWakeSessionKey(kind: string, id: string): string {
  return `${AAMP_SESSION_PREFIX}wake:${kind}:${id}`
}

function saveTerminalTaskIds(): void {
  saveTaskState({ terminalTaskIds: [...terminalTaskIds] }, defaultTaskStatePath())
}

function rememberTerminalTask(taskId: string): void {
  terminalTaskIds.add(taskId)
  saveTerminalTaskIds()
}

function priorityRank(priority: TaskPriority): number {
  switch (priority) {
    case 'urgent':
      return 0
    case 'high':
      return 1
    default:
      return 2
  }
}

function hasExpired(task: Pick<PendingTask, 'expiresAt'>): boolean {
  if (task.expiresAt) {
    const expiresAtMs = new Date(task.expiresAt).getTime()
    if (Number.isFinite(expiresAtMs) && Date.now() >= expiresAtMs) return true
  }
  return false
}

function isTransientTransportError(message: string): boolean {
  return [
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'EPIPE',
    'UND_ERR_SOCKET',
    'UND_ERR_CONNECT_TIMEOUT',
    'fetch failed',
  ].some((needle) => message.includes(needle))
}

function nextPendingEntry(): [string, PendingTask] | undefined {
  const entries = [...pendingTasks.entries()]
  const notifications = entries.filter(([key]) => key.startsWith('result:') || key.startsWith('help:'))
  if (notifications.length > 0) {
    return notifications.sort((a, b) => new Date(a[1].receivedAt).getTime() - new Date(b[1].receivedAt).getTime())[0]
  }

  return entries
    .filter(([key]) => !key.startsWith('result:') && !key.startsWith('help:'))
    .sort((a, b) => {
      const rankDiff = priorityRank(a[1].priority) - priorityRank(b[1].priority)
      if (rankDiff !== 0) return rankDiff
      return new Date(a[1].receivedAt).getTime() - new Date(b[1].receivedAt).getTime()
    })[0]
}

export function queuePendingTask(
  task: TaskDispatch & { threadHistory?: AampThreadEvent[]; threadContextText?: string },
): boolean {
  if (terminalTaskIds.has(task.taskId)) {
    return false
  }

  pendingTasks.set(task.taskId, {
    taskId: task.taskId,
    from: task.from,
    title: task.title,
    bodyText: task.bodyText ?? '',
    threadHistory: task.threadHistory ?? [],
    threadContextText: task.threadContextText ?? '',
    priority: task.priority ?? 'normal',
    ...(task.expiresAt ? { expiresAt: task.expiresAt } : {}),
    contextLinks: task.contextLinks ?? [],
    messageId: task.messageId ?? '',
    receivedAt: new Date().toISOString(),
  })

  if (hasExpired(pendingTasks.get(task.taskId)!)) {
    pendingTasks.delete(task.taskId)
    rememberTerminalTask(task.taskId)
    return false
  }

  return true
}

// ─── Identity helpers ─────────────────────────────────────────────────────────

interface Identity {
  email: string
  mailboxToken?: string
  smtpPassword: string
}

/**
 * Register a new AAMP node via the management service.
 *
 * Always creates a NEW mailbox (always returns 201). The slug is just a
 * human-readable prefix; a random hex suffix makes the email unique.
 * Callers should only call this once and persist the returned credentials.
 */
export async function registerNode(cfg: PluginConfig): Promise<Identity> {
  const slug = (cfg.slug ?? 'openclaw-agent')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')

  const base = baseUrl(cfg.aampHost)
  const discoveryRes = await fetch(`${base}/.well-known/aamp`)
  if (!discoveryRes.ok) {
    throw new Error(`AAMP discovery failed (${discoveryRes.status}): ${discoveryRes.statusText}`)
  }
  const discovery = (await discoveryRes.json()) as { api?: { url?: string } }
  const apiUrl = discovery.api?.url
  if (!apiUrl) {
    throw new Error('AAMP discovery did not return api.url')
  }

  const apiBase = new URL(apiUrl, `${base}/`).toString()

  // Step 1: Self-register → get one-time registration code
  const res = await fetch(`${apiBase}?action=aamp.mailbox.register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, description: 'OpenClaw AAMP agent node' }),
  })

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(`AAMP registration failed (${res.status}): ${err.error ?? res.statusText}`)
  }

  const regData = (await res.json()) as {
    registrationCode: string
    email: string
  }

  // Step 2: Exchange registration code for credentials
  const credRes = await fetch(
    `${apiBase}?action=aamp.mailbox.credentials&code=${encodeURIComponent(regData.registrationCode)}`,
  )

  if (!credRes.ok) {
    const err = (await credRes.json().catch(() => ({}))) as { error?: string }
    throw new Error(`AAMP credential exchange failed (${credRes.status}): ${err.error ?? credRes.statusText}`)
  }

  const credData = (await credRes.json()) as {
    email: string
    mailbox: { token: string }
    smtp: { password: string }
  }

  return {
    email: credData.email,
    mailboxToken: credData.mailbox.token,
    smtpPassword: credData.smtp.password,
  }
}

/**
 * Resolve this agent's identity:
 *   1. Return cached credentials from disk if available.
 *   2. Otherwise register a new node and cache the result.
 */
export async function resolveIdentity(cfg: PluginConfig): Promise<Identity> {
  const cached = loadCachedIdentity(cfg.credentialsFile ?? defaultCredentialsPath())
  if (cached) return cached

  const identity = await registerNode(cfg)
  saveCachedIdentity(identity, cfg.credentialsFile ?? defaultCredentialsPath())
  return identity
}

// ─── Plugin definition ────────────────────────────────────────────────────────

export default {
  id: 'aamp-openclaw-plugin',
  name: 'AAMP Agent Mail Protocol',

  configSchema: {
    type: 'object',
    properties: {
      aampHost: {
        type: 'string',
        description: 'AAMP service host, e.g. https://meshmail.ai',
      },
      slug: {
        type: 'string',
        default: 'openclaw-agent',
        description: 'Agent name prefix used in the mailbox address',
      },
      summary: {
        type: 'string',
        description: 'Directory summary shown when other agents search for this agent.',
      },
      cardText: {
        type: 'string',
        description: 'Inline card text used for automatic card.response replies.',
      },
      cardFile: {
        type: 'string',
        description: 'Absolute path to a card text file. Used when cardText is not set.',
      },
      credentialsFile: {
        type: 'string',
        description:
          'Absolute path to cache AAMP credentials between gateway restarts. ' +
          'Default: ~/.openclaw/extensions/aamp-openclaw-plugin/.credentials.json. ' +
          'Delete this file to force re-registration with a new mailbox.',
      },
      senderPolicies: {
        type: 'array',
        description:
          'Per-sender authorization policies. Each sender can optionally require specific ' +
          'X-AAMP-Dispatch-Context key/value pairs before a task is accepted.',
        items: {
          type: 'object',
          required: ['sender'],
          properties: {
            sender: {
              type: 'string',
              description: 'Dispatch sender email address (case-insensitive exact match).',
            },
            dispatchContextRules: {
              type: 'object',
              description:
                'Optional exact-match rules over X-AAMP-Dispatch-Context. ' +
                'All listed keys must be present and their values must match one of the configured entries.',
              additionalProperties: {
                type: 'array',
                items: { type: 'string' },
              },
            },
          },
        },
      },
    },
  },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(api: any) {
    // OpenClaw channel plugins keep runtime config under channels.<channelId>.
    // Fall back to the legacy plugins.entries config so older installs still work.
    const cfg = ((api.config?.channels?.aamp ?? api.pluginConfig ?? {}) as PluginConfig)

    // ── Register lightweight channel adapter to capture channelRuntime ──────────
    // We register as a channel SOLELY to get access to channelRuntime, which provides
    // dispatchReplyWithBufferedBlockDispatcher for instant LLM dispatch (bypassing
    // heartbeat's global running-mutex + requests-in-flight ~60s delay).
    // JMAP connection is managed by registerService, NOT startAccount.
    api.registerChannel({
      id: 'aamp',
      meta: {
        label: 'AAMP',
        selectionLabel: 'AAMP',
        docsPath: '/channels/aamp',
        blurb: 'AAMP mailbox channel for receiving and replying to tasks over email.',
      },
      capabilities: { chatTypes: ['dm'] },
      config: {
        listAccountIds: () => cfg.aampHost ? ['default'] : [],
        resolveAccount: () => ({ aampHost: cfg.aampHost }),
        isEnabled: () => !!cfg.aampHost,
        isConfigured: () => !!loadCachedIdentity(cfg.credentialsFile ?? defaultCredentialsPath()),
      },
      gateway: {
        startAccount: async (ctx: { channelRuntime?: unknown; cfg?: unknown; abortSignal?: AbortSignal }) => {
          // Capture channelRuntime for use by sub-task notification dispatch
          channelRuntime = ctx.channelRuntime ?? null
          channelCfg = ctx.cfg ?? null
          api.logger.info(`[AAMP] Channel adapter started — channelRuntime ${channelRuntime ? 'available' : 'NOT available'}`)

          // Keep alive until abort — JMAP connection is managed by registerService
          await new Promise<void>((resolve) => {
            ctx.abortSignal?.addEventListener('abort', () => resolve())
          })
          channelRuntime = null
          channelCfg = null
        },
        stopAccount: async () => {
          channelRuntime = null
          channelCfg = null
        },
      },
    })

    function triggerHeartbeatWake(sessionKey: string, label: string): void {
      try {
        api.runtime.system.requestHeartbeatNow({ reason: 'wake', sessionKey })
        api.logger.info(`[AAMP] Heartbeat triggered for ${label} via session ${sessionKey}`)
      } catch (err) {
        api.logger.warn(`[AAMP] Could not trigger heartbeat for ${label}: ${(err as Error).message}`)
      }
    }

    function getConfiguredCardText(): string | undefined {
      const inline = cfg.cardText?.trim()
      if (inline) return inline

      const file = cfg.cardFile?.trim()
      if (!file) return undefined

      const fromFile = readFileSync(file, 'utf-8').trim()
      return fromFile || undefined
    }

    async function syncDirectoryProfile(): Promise<void> {
      if (!aampClient) return

      const summary = cfg.summary?.trim()
      const cardText = getConfiguredCardText()
      if (!summary && !cardText) return

      await aampClient.updateDirectoryProfile({
        ...(summary ? { summary } : {}),
        ...(cardText ? { cardText } : {}),
      })

      api.logger.info(`[AAMP] Directory profile synced${cardText ? ' (card text registered)' : ''}`)
    }

    function wakeAgentForPendingTask(task: PendingTask): void {
      const fallbackSessionKey = buildAampWakeSessionKey('task', task.taskId)
      const openClawSessionKey = buildAampTaskSessionKey(task.taskId, api.config)
      const fallback = () => triggerHeartbeatWake(fallbackSessionKey, `task ${task.taskId}`)
      const dispatcher = channelRuntime?.reply?.dispatchReplyWithBufferedBlockDispatcher

      api.logger.info(
        `[AAMP] Wake requested for task ${task.taskId} — channelRuntime=${channelRuntime ? 'yes' : 'no'} channelCfg=${channelCfg ? 'yes' : 'no'} dispatcher=${typeof dispatcher === 'function' ? 'yes' : 'no'} session=${openClawSessionKey} fallbackSession=${fallbackSessionKey}`,
      )

      if (!channelRuntime || !channelCfg || typeof dispatcher !== 'function') {
        fallback()
        return
      }

      const prompt = [
        '## New AAMP Task',
        '',
        'A new AAMP task just arrived.',
        'Use the pending AAMP task in system context as the source of truth and handle it now.',
        'Reply with aamp_send_result or aamp_send_help before responding.',
      ].join('\n')

      try {
        void Promise.resolve(dispatcher({
          ctx: {
            Body: task.bodyText || task.title,
            BodyForAgent: prompt,
            From: task.from,
            To: agentEmail,
            SessionKey: openClawSessionKey,
            AccountId: 'default',
            ChatType: 'dm',
            Provider: 'aamp',
            Surface: 'aamp',
            OriginatingChannel: 'aamp',
            OriginatingTo: task.from,
            MessageSid: task.messageId || task.taskId,
            Timestamp: Date.now(),
            SenderName: task.from,
            SenderId: task.from,
            CommandAuthorized: true,
          },
          cfg: channelCfg,
          dispatcherOptions: {
            deliver: async () => {},
            onError: (err: unknown) => {
              api.logger.error(`[AAMP] Channel dispatch error for task ${task.taskId}: ${err instanceof Error ? err.message : String(err)}`)
            },
          },
        })).then(() => {
          api.logger.info(`[AAMP] Channel dispatch triggered for task ${task.taskId}`)
        }).catch((err: Error) => {
          api.logger.error(`[AAMP] Channel dispatch failed for task ${task.taskId}: ${err.message}`)
          fallback()
        })
      } catch (err) {
        api.logger.error(`[AAMP] Channel dispatch threw synchronously for task ${task.taskId}: ${(err as Error).message}`)
        fallback()
      }
    }

    async function reconcileMailbox(includeHistorical: boolean): Promise<void> {
      if (!aampClient) return

      const opts = includeHistorical ? { includeHistorical: true } : undefined
      const count = await aampClient.reconcileRecentEmails(100, opts)

      if (includeHistorical && !historicalReconcileCompleted) {
        historicalReconcileCompleted = true
        api.logger.info(`[AAMP] Historical mailbox reconcile complete (${count} email(s) scanned)`)
      }
    }

    // ── Shared connect logic (used by service auto-connect and startup recovery) ──────
    async function doConnect(identity: { email: string; mailboxToken?: string; smtpPassword: string }) {
      if (reconcileTimer) {
        clearInterval(reconcileTimer)
        reconcileTimer = null
      }
      if (transportMonitorTimer) {
        clearInterval(transportMonitorTimer)
        transportMonitorTimer = null
      }

      agentEmail = identity.email
      lastConnectionError = ''
      lastDisconnectReason = ''
      lastTransportMode = 'disconnected'
      lastLoggedTransportMode = 'disconnected'
      api.logger.info(`[AAMP] Mailbox identity ready — ${agentEmail}`)

      // All traffic goes through aampHost (port 3000).
      // The management service proxies /jmap/* and /.well-known/jmap → Stalwart:8080.
      const base = baseUrl(cfg.aampHost)

      aampClient = AampClient.fromMailboxIdentity({
        email: identity.email,
        smtpPassword: identity.smtpPassword,
        baseUrl: base,
        // Local/dev: management-service proxy uses plain HTTP, no TLS cert to verify.
        // Production: set to true when using wss:// with valid certs.
        rejectUnauthorized: false,
      })

      aampClient.on('task.dispatch', (task: TaskDispatch) => {
        api.logger.info(`[AAMP] ← task.dispatch  ${task.taskId}  "${task.title}"  from=${task.from}`)

        void (async () => {
          try {
          if (terminalTaskIds.has(task.taskId)) {
            api.logger.info(`[AAMP] Skipping already-terminal task ${task.taskId}`)
            return
          }

          // ── Sender policy / dispatch-context authorization ────────────────────
          const decision = matchSenderPolicy(task, cfg.senderPolicies)
          if (!decision.allowed) {
            api.logger.warn(`[AAMP] ✗ rejected by senderPolicies: ${task.from}  task=${task.taskId}  reason=${decision.reason}`)
            void aampClient!.sendResult({
              to: task.from,
              taskId: task.taskId,
              status: 'rejected',
              output: '',
              errorMsg: decision.reason ?? `Sender ${task.from} is not allowed.`,
            }).catch((err: Error) => {
              api.logger.error(`[AAMP] Failed to send rejection for task ${task.taskId}: ${err.message}`)
            })
            return
          }

          const hydratedTask = await aampClient!.hydrateTaskDispatch(task).catch((err: Error) => {
            api.logger.warn(`[AAMP] Failed to load thread history for ${task.taskId}: ${err.message}`)
            return {
              ...task,
              threadHistory: [],
              threadContextText: '',
            }
          })

          if (!queuePendingTask(hydratedTask)) {
            api.logger.info(`[AAMP] Ignoring already-terminal or expired task ${task.taskId}`)
            return
          }

          void ensureTaskStream(pendingTasks.get(task.taskId)!).catch((err: Error) => {
            api.logger.warn(`[AAMP] Failed to open stream for task ${task.taskId}: ${err.message}`)
          })

          // Wake the agent immediately after enqueueing the task.
          // In polling fallback mode heartbeat wakes can be delayed, so prefer a direct
          // channel dispatch when channelRuntime is available and only fall back to heartbeat.
          wakeAgentForPendingTask(pendingTasks.get(task.taskId)!)
        } catch (err) {
          api.logger.error(`[AAMP] task.dispatch handler failed for ${task.taskId}: ${(err as Error).message}`)
          if (pendingTasks.has(task.taskId)) {
            triggerHeartbeatWake(buildAampWakeSessionKey('task', task.taskId), `task ${task.taskId}`)
          }
        }
        })()
      })

      aampClient.on('task.cancel', (cancel: TaskCancel) => {
        api.logger.info(`[AAMP] ← task.cancel  ${cancel.taskId}  from=${cancel.from}`)
        const removed = pendingTasks.delete(cancel.taskId)
        pendingTasks.delete(`result:${cancel.taskId}`)
        pendingTasks.delete(`help:${cancel.taskId}`)
        dispatchedSubtasks.delete(cancel.taskId)
        waitingDispatches.delete(cancel.taskId)
        rememberTerminalTask(cancel.taskId)
        void closeTaskStream(cancel.taskId, { reason: 'task.cancel' }).catch(() => {})
        if (removed) {
          api.logger.info(`[AAMP] Cancelled task ${cancel.taskId} — removed from pending queue`)
        }
      })

      // ── Sub-task result: another agent completed a task we dispatched ──────
      aampClient.on('task.result', (result: TaskResult) => {
        if (result.from.toLowerCase() === agentEmail.toLowerCase()) return
        api.logger.info(`[AAMP] ← task.result  ${result.taskId}  status=${result.status}  from=${result.from}`)

        const sub = dispatchedSubtasks.get(result.taskId)
        dispatchedSubtasks.delete(result.taskId)

        // ── Synchronous dispatch: if aamp_dispatch_task is waiting, resolve it directly ──
        const waiter = waitingDispatches.get(result.taskId)
        if (waiter) {
          waitingDispatches.delete(result.taskId)
          api.logger.info(`[AAMP] Resolving sync waiter for sub-task ${result.taskId}`)
          waiter({ type: 'result', data: result })
          return  // Don't go through heartbeat/channel — the LLM is already awake
        }

        // Pre-download attachments to local disk so the LLM can reference them
        // by local file path (instead of requiring a separate download tool call).
        const downloadedFiles: Array<{ filename: string; path: string; size: number }> = []
        const downloadPromise = (async () => {
          if (!result.attachments?.length) return
          const dir = '/tmp/aamp-files'
          ensureDir(dir)
          for (const att of result.attachments) {
            try {
              const buffer = await aampClient!.downloadBlob(att.blobId, att.filename)
              const filepath = `${dir}/${att.filename}`
              writeBinaryFile(filepath, buffer)
              downloadedFiles.push({ filename: att.filename, path: filepath, size: buffer.length })
              api.logger.info(`[AAMP] Pre-downloaded: ${att.filename} (${(buffer.length / 1024).toFixed(1)} KB) → ${filepath}`)
            } catch (dlErr) {
              api.logger.warn(`[AAMP] Pre-download failed for ${att.filename}: ${(dlErr as Error).message}`)
            }
          }
        })()

        downloadPromise.then(() => {
          // Build notification with pre-downloaded file paths
          const MAX_OUTPUT_CHARS = 800
          const label = result.status === 'completed' ? 'Sub-task completed' : 'Sub-task rejected'
          const rawOutput = result.output ?? ''
          const truncatedOutput = rawOutput.length > MAX_OUTPUT_CHARS
            ? rawOutput.slice(0, MAX_OUTPUT_CHARS) + `\n\n... [truncated, ${rawOutput.length} chars total]`
            : rawOutput

          let attachmentInfo = ''
          if (downloadedFiles.length > 0) {
            attachmentInfo = `\n\nAttachments (pre-downloaded to local disk):\n${downloadedFiles.map(f =>
              `- ${f.filename} (${(f.size / 1024).toFixed(1)} KB) → ${f.path}`
            ).join('\n')}\nUse aamp_send_result with attachments: [${downloadedFiles.map(f => `{ filename: "${f.filename}", path: "${f.path}" }`).join(', ')}] to forward them.`
          } else if (result.attachments?.length) {
            const files = result.attachments.map((a: ReceivedAttachment) =>
              `${a.filename} (${(a.size / 1024).toFixed(1)} KB, blobId: ${a.blobId})`,
            )
            attachmentInfo = `\n\nAttachments (download failed — use aamp_download_attachment manually):\n${files.join('\n')}`
          }

          pendingTasks.set(`result:${result.taskId}`, {
            taskId: result.taskId,
            from: result.from,
            title: `${label}: ${sub?.title ?? result.taskId}`,
            bodyText: result.status === 'completed'
              ? `Agent ${result.from} completed the sub-task.\n\nOutput:\n${truncatedOutput}${attachmentInfo}`
              : `Agent ${result.from} rejected the sub-task.\n\nReason: ${result.errorMsg ?? 'unknown'}`,
            priority: 'urgent',
            contextLinks: [],
            messageId: '',
            receivedAt: new Date().toISOString(),
          })

          // Wake LLM via channel dispatch (instant) or heartbeat (fallback)
          if (channelRuntime && channelCfg) {
            const notifyBody = pendingTasks.get(`result:${result.taskId}`)
            const actionableTasks = [...pendingTasks.entries()]
              .filter(([key]) => !key.startsWith('result:') && !key.startsWith('help:'))
              .map(([, t]) => t)
            const actionSection = actionableTasks.length > 0
              ? `\n\n### Action Required\nYou MUST call aamp_send_result to complete the pending task(s):\n${actionableTasks.map(t => `- Task ID: ${t.taskId} | From: ${t.from} | Title: "${t.title}"`).join('\n')}`
              : ''
            const prompt = `## Sub-task Update\n\n${notifyBody?.bodyText ?? 'Sub-task completed.'}${actionSection}`

            channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
              ctx: {
                Body: `Sub-task result: ${result.taskId}`,
                BodyForAgent: prompt,
                From: result.from,
                To: agentEmail,
                SessionKey: buildAampConversationSessionKey(result.from, api.config),
                AccountId: 'default',
                ChatType: 'dm',
                Provider: 'aamp',
                Surface: 'aamp',
                OriginatingChannel: 'aamp',
                OriginatingTo: result.from,
                MessageSid: result.taskId,
                Timestamp: Date.now(),
                SenderName: result.from,
                SenderId: result.from,
                CommandAuthorized: true,
              },
              cfg: channelCfg,
              dispatcherOptions: {
                deliver: async () => {},
                onError: (err: unknown) => {
                  api.logger.error(`[AAMP] Channel dispatch error: ${err instanceof Error ? err.message : String(err)}`)
                },
              },
            }).then(() => {
              api.logger.info(`[AAMP] Channel dispatch completed for sub-task result ${result.taskId}`)
              pendingTasks.delete(`result:${result.taskId}`)
            }).catch((err: Error) => {
              api.logger.error(`[AAMP] Channel dispatch failed: ${err.message}`)
            })
          } else {
            const notifySessionKey = buildAampWakeSessionKey('result', result.taskId)
            try {
              api.runtime.system.requestHeartbeatNow({ reason: 'wake', sessionKey: notifySessionKey })
              api.logger.info(`[AAMP] Heartbeat for sub-task result ${result.taskId}`)
            } catch (err) {
              api.logger.warn(`[AAMP] Heartbeat for sub-task result failed: ${(err as Error).message}`)
            }
          }
        }).catch((err: Error) => {
          api.logger.error(`[AAMP] Sub-task result processing failed: ${err.message}`)
        })
      })

      // ── Sub-task help_needed: another agent asks for clarification ──────────
      aampClient.on('task.help_needed', (help: TaskHelp) => {
        if (help.from.toLowerCase() === agentEmail.toLowerCase()) return
        api.logger.info(`[AAMP] ← task.help_needed  ${help.taskId}  question="${help.question}"  from=${help.from}`)

        // ── Synchronous dispatch: if aamp_dispatch_task is waiting, resolve it directly ──
        const waiter = waitingDispatches.get(help.taskId)
        if (waiter) {
          waitingDispatches.delete(help.taskId)
          api.logger.info(`[AAMP] Resolving sync waiter for sub-task help ${help.taskId}`)
          waiter({ type: 'help', data: help })
          return
        }

        const sub = dispatchedSubtasks.get(help.taskId)

        pendingTasks.set(`help:${help.taskId}`, {
          taskId: help.taskId,
          from: help.from,
          title: `Sub-task needs help: ${sub?.title ?? help.taskId}`,
          bodyText: `Agent ${help.from} is asking for help on the sub-task.\n\nQuestion: ${help.question}\nBlocked reason: ${help.blockedReason}${help.suggestedOptions?.length ? `\nSuggested options: ${help.suggestedOptions.join(', ')}` : ''}`,
          priority: 'urgent',
          contextLinks: [],
          messageId: '',
          receivedAt: new Date().toISOString(),
        })

        if (channelRuntime && channelCfg) {
          const notifyBody = pendingTasks.get(`help:${help.taskId}`)
          const prompt = `## Sub-task Help Request\n\n${notifyBody?.bodyText ?? help.question}`

          channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: {
              Body: `Sub-task help: ${help.taskId}`,
              BodyForAgent: prompt,
              From: help.from,
              To: agentEmail,
              SessionKey: buildAampConversationSessionKey(help.from, api.config),
              AccountId: 'default',
              ChatType: 'dm',
              Provider: 'aamp',
              Surface: 'aamp',
              OriginatingChannel: 'aamp',
              OriginatingTo: help.from,
              MessageSid: help.taskId,
              Timestamp: Date.now(),
              SenderName: help.from,
              SenderId: help.from,
              CommandAuthorized: true,
            },
            cfg: channelCfg,
            dispatcherOptions: {
              deliver: async () => {},
              onError: (err: unknown) => {
                api.logger.error(`[AAMP] Channel dispatch error (help): ${err instanceof Error ? err.message : String(err)}`)
              },
            },
          }).then(() => {
            pendingTasks.delete(`help:${help.taskId}`)
          }).catch((err: Error) => {
            api.logger.error(`[AAMP] Channel dispatch failed for help: ${err.message}`)
          })
        } else {
          const helpSessionKey = buildAampWakeSessionKey('help', help.taskId)
          try {
            api.runtime.system.requestHeartbeatNow({ reason: 'wake', sessionKey: helpSessionKey })
            api.logger.info(`[AAMP] Heartbeat fallback for sub-task help ${help.taskId}`)
          } catch (err) {
            api.logger.warn(`[AAMP] Heartbeat for sub-task help failed: ${(err as Error).message}`)
          }
        }
      })

      aampClient.on('connected', () => {
        lastConnectionError = ''
        lastDisconnectReason = ''
        const mode = aampClient?.isUsingPollingFallback() ? 'polling' : 'websocket'
        logTransportState(api, mode, agentEmail, lastLoggedTransportMode)
        lastTransportMode = mode
        lastLoggedTransportMode = mode
      })

      aampClient.on('disconnected', (reason: string) => {
        lastDisconnectReason = reason
        if (lastTransportMode !== 'disconnected') {
          api.logger.warn(`[AAMP] Disconnected: ${reason} (will auto-reconnect)`)
          lastTransportMode = 'disconnected'
          lastLoggedTransportMode = 'disconnected'
        }
      })

      aampClient.on('error', (err: Error) => {
        lastConnectionError = err.message
        if (err.message.startsWith('JMAP WebSocket unavailable, falling back to polling:')) {
          if (lastTransportMode !== 'polling') {
            logTransportState(api, 'polling', agentEmail, lastLoggedTransportMode)
            lastTransportMode = 'polling'
            lastLoggedTransportMode = 'polling'
          }
          return
        }
        if (err.message.startsWith('Safety reconcile failed:') && isTransientTransportError(err.message)) {
          api.logger.warn(`[AAMP] ${err.message}`)
          return
        }
        api.logger.error(`[AAMP] ${err.message}`)
      })

      await aampClient.connect()
      await syncDirectoryProfile().catch((err: Error) => {
        api.logger.warn(`[AAMP] Directory profile sync failed: ${err.message}`)
      })

      api.logger.info(
        `[AAMP] Transport after connect — ${aampClient.isUsingPollingFallback() ? 'polling fallback' : 'websocket'} as ${agentEmail}`,
      )

      if (aampClient.isConnected() && lastTransportMode === 'disconnected') {
        if (aampClient.isUsingPollingFallback()) {
          logTransportState(api, 'polling', agentEmail, lastLoggedTransportMode)
          lastTransportMode = 'polling'
          lastLoggedTransportMode = 'polling'
        } else {
          logTransportState(api, 'websocket', agentEmail, lastLoggedTransportMode)
          lastTransportMode = 'websocket'
          lastLoggedTransportMode = 'websocket'
        }
      }

      setTimeout(() => {
        if (!aampClient?.isConnected()) return
        const mode = aampClient.isUsingPollingFallback() ? 'polling' : 'websocket'
        logTransportState(api, mode, agentEmail, lastLoggedTransportMode)
        lastTransportMode = mode
        lastLoggedTransportMode = mode
      }, 1000)

      void reconcileMailbox(!historicalReconcileCompleted).catch((err: Error) => {
        lastConnectionError = err.message
        if (!historicalReconcileCompleted) {
          api.logger.warn(`[AAMP] Startup mailbox reconcile failed: ${err.message} (will retry historical tasks)`)
        } else {
          api.logger.warn(`[AAMP] Startup mailbox reconcile failed: ${err.message}`)
        }
      })

      transportMonitorTimer = setInterval(() => {
        if (!aampClient) return
        if (!aampClient.isConnected()) {
          if (lastTransportMode !== 'disconnected') {
            lastTransportMode = 'disconnected'
          }
          return
        }
        const mode = aampClient.isUsingPollingFallback() ? 'polling' : 'websocket'
        logTransportState(api, mode, agentEmail, lastLoggedTransportMode)
        lastTransportMode = mode
        lastLoggedTransportMode = mode
      }, 5000)

      reconcileTimer = setInterval(() => {
        if (!aampClient) return
        const includeHistorical = !historicalReconcileCompleted
        void reconcileMailbox(includeHistorical).catch((err: Error) => {
          lastConnectionError = err.message
          if (includeHistorical) {
            api.logger.warn(`[AAMP] Mailbox reconcile failed while retrying historical tasks: ${err.message}`)
          } else {
            api.logger.warn(`[AAMP] Mailbox reconcile failed: ${err.message}`)
          }
        })
      }, 15000)
    }

    // ── Service: auto-connect at gateway startup, disconnect on shutdown ────────
    // registerService causes this plugin to load eagerly (at gateway startup),
    // not lazily (on first agent run). start() is called once the gateway is up.
    api.registerService({
      id: 'aamp-service',
      start: async () => {
        if (!cfg.aampHost) {
          api.logger.info('[AAMP] aampHost not configured — skipping auto-connect')
          return
        }
        try {
          const identity = await resolveIdentity(cfg)
          await doConnect(identity)
        } catch (err) {
          api.logger.warn(`[AAMP] Service auto-connect failed: ${(err as Error).message}`)
        }
      },
      stop: () => {
        if (reconcileTimer) {
          clearInterval(reconcileTimer)
          reconcileTimer = null
        }
        if (transportMonitorTimer) {
          clearInterval(transportMonitorTimer)
          transportMonitorTimer = null
        }
        if (aampClient) {
          try {
            aampClient.disconnect()
            api.logger.info('[AAMP] Disconnected on gateway stop')
          } catch {
            // ignore disconnect errors on shutdown
          }
        }
      },
    })

    // ── gateway_start hook: re-trigger heartbeat after runner is initialized ───
    // Service start() runs BEFORE the heartbeat runner is ready, so
    // requestHeartbeatNow() called during JMAP initial fetch is silently dropped
    // (handler == null). gateway_start fires AFTER the heartbeat runner starts,
    // so we re-trigger here to process any tasks queued during startup.
    api.on('gateway_start', () => {
      if (pendingTasks.size === 0) return
      api.logger.info(`[AAMP] gateway_start: re-triggering heartbeat for ${pendingTasks.size} pending task(s)`)
      try {
        api.runtime.system.requestHeartbeatNow({
          reason: 'wake',
          sessionKey: buildAampWakeSessionKey('queue', 'gateway-start'),
        })
      } catch (err) {
        api.logger.warn(`[AAMP] gateway_start heartbeat failed: ${(err as Error).message}`)
      }
    })

    // ── 2. Prompt injection: surface the oldest pending task to the LLM ──────
    api.on(
      'before_prompt_build',
      (_event, ctx) => {
        // Only AAMP-owned sessions should receive mailbox task context.
        // This prevents regular user chats from inheriting pending email instructions.
        if (!isAampSessionKey(ctx?.sessionKey)) {
          return {}
        }

        // Expire tasks that have exceeded their dispatch expiry window.
        for (const [id, t] of pendingTasks) {
          if (hasExpired(t)) {
            if (!isSyntheticPendingKey(id) && aampClient?.isConnected()) {
              void aampClient.sendResult({
                to: t.from,
                taskId: t.taskId,
                status: 'rejected',
                output: '',
                errorMsg: t.expiresAt
                  ? 'Task expired before the agent could complete it.'
                  : 'Task timed out while waiting for agent completion or follow-up input.',
                inReplyTo: t.messageId || undefined,
              }).then(() => {
                rememberTerminalTask(t.taskId)
                api.logger.warn(`[AAMP] Task ${id} expired — sent rejected result to dispatcher`)
              }).catch((err: Error) => {
                api.logger.error(`[AAMP] Task ${id} expired — failed to notify dispatcher: ${err.message}`)
              })
            } else {
              rememberTerminalTask(t.taskId)
              api.logger.warn(`[AAMP] Task ${id} expired — removing from queue`)
            }
            pendingTasks.delete(id)
          }
        }

        if (pendingTasks.size === 0) return {}

        // Prioritize notifications (sub-task results/help) over actionable tasks.
        // Without this, the oldest actionable task blocks notification delivery,
        // preventing the LLM from seeing sub-task results and completing the parent task.
        const nextEntry = nextPendingEntry()
        if (!nextEntry) return {}
        const [taskKey, task] = nextEntry

        const isNotification = taskKey.startsWith('result:') || taskKey.startsWith('help:')

        // Notifications are one-shot: remove immediately after injecting into prompt
        if (isNotification && taskKey) {
          pendingTasks.delete(taskKey)
        }

        // Find remaining actionable tasks (non-notification) that still need a response
        const actionableTasks = [...pendingTasks.entries()]
          .filter(([key]) => !key.startsWith('result:') && !key.startsWith('help:'))
          .map(([, t]) => t)
          .sort((a, b) => {
            const rankDiff = priorityRank(a.priority) - priorityRank(b.priority)
            if (rankDiff !== 0) return rankDiff
            return new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime()
          })

        const hasAttachmentInfo = isNotification && (task.bodyText?.includes('aamp_download_attachment') ?? false)
        const actionRequiredSection = isNotification && actionableTasks.length > 0
          ? [
              ``,
              `### Action Required`,
              ``,
              `You still have ${actionableTasks.length} pending task(s) that need a response.`,
              `Use the sub-task result above to complete them by calling aamp_send_result.`,
              ``,
              ...actionableTasks.map((t) =>
                `- [${t.priority}] Task ID: ${t.taskId} | From: ${t.from} | Title: "${t.title}"`
              ),
              ...(hasAttachmentInfo ? [
                ``,
                `### Forwarding Attachments`,
                `The sub-task result includes file attachments. To forward them:`,
                `1. Call aamp_download_attachment for each blobId listed above`,
                `2. Include the downloaded files in aamp_send_result via the attachments parameter`,
                `   Example: attachments: [{ filename: "file.html", path: "/tmp/aamp-files/file.html" }]`,
              ] : []),
            ].join('\n')
          : ''

        const lines = isNotification ? [
          `## Sub-task Update`,
          ``,
          `A sub-task you dispatched has returned a result. Review the information below.`,
          `If the sub-task included attachments, use aamp_download_attachment to fetch them.`,
          ``,
          `Task ID:  ${task.taskId}`,
          `Priority: ${task.priority}`,
          `From:     ${task.from}`,
          `Title:    ${task.title}`,
          task.bodyText ? `\n${task.bodyText}` : '',
          actionRequiredSection,
          pendingTasks.size > 1 ? `\n(+${pendingTasks.size - 1} more items queued)` : '',
        ] : [
          `## Pending AAMP Task (action required)`,
          ``,
          `You have received a task via AAMP email. You MUST call one of the two tools below`,
          `BEFORE responding to the user — do not skip this step.`,
          ``,
          `### Tool selection rules (follow strictly):`,
          ``,
          `Use aamp_send_result ONLY when ALL of the following are true:`,
          `  1. The title contains a clear, specific action verb (e.g. "summarise", "review",`,
          `     "translate", "generate", "fix", "search", "compare", "list")`,
          `  2. You know exactly what input/resource to act on`,
          `  3. No ambiguity remains — you could start work immediately without asking anything`,
          ``,
          `Use aamp_send_help in ALL other cases, including:`,
          `  - Title is a greeting or salutation ("hello", "hi", "hey", "test", "ping", etc.)`,
          `  - Title is fewer than 4 words and contains no actionable verb`,
          `  - Title is too vague to act on without guessing (e.g. "help", "task", "question")`,
          `  - Required context is missing (which file? which URL? which criteria?)`,
          `  - Multiple interpretations are equally plausible`,
          ``,
          `IMPORTANT: Responding to a greeting with a greeting is WRONG. "hello" is not a`,
          `valid task description — ask what specific task the dispatcher needs done.`,
          ``,
          `### Sub-task dispatch rules:`,
          `If you delegate work to another agent via aamp_dispatch_task, you MUST pass`,
          `parentTaskId: "${task.taskId}" to establish the parent-child relationship.`,
          `If you need to find a suitable agent first, call aamp_directory_search.`,
          ``,
          `Task ID:  ${task.taskId}`,
          `From:     ${task.from}`,
          `Title:    ${task.title}`,
          task.threadContextText ? `${task.threadContextText}` : '',
          task.bodyText ? `Description:\n${task.bodyText}` : '',
          task.contextLinks.length
            ? `Context Links:\n${task.contextLinks.map((l) => `  - ${l}`).join('\n')}`
            : '',
          task.expiresAt ? `Expires: ${task.expiresAt}` : `Expires: none`,
          `Received: ${task.receivedAt}`,
          pendingTasks.size > 1 ? `\n(+${pendingTasks.size - 1} more tasks queued)` : '',
        ]
          .filter(Boolean)
          .join('\n')

        return { prependContext: lines }
      },
      { priority: 5 },
    )

    // ── 3. Tool: send task result ─────────────────────────────────────────────
    api.registerTool({
      name: 'aamp_directory_search',
      description:
        'Search the AAMP directory for agents by capability summary, card text, or email address.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Capability or keyword to search for' },
          limit: { type: 'number', description: 'Maximum number of matches to return (default: 10)' },
          includeSelf: { type: 'boolean', description: 'Whether to include the current agent in results' },
        },
      },
      execute: async (_id, params) => {
        if (!aampClient) {
          return { content: [{ type: 'text', text: 'Error: AAMP client is not connected.' }] }
        }

        const query = String((params as { query?: string }).query ?? '').trim()
        if (!query) {
          return { content: [{ type: 'text', text: 'Error: query is required.' }] }
        }

        const agents = await aampClient.searchDirectory({
          query,
          limit: Number((params as { limit?: number }).limit ?? 10),
          includeSelf: Boolean((params as { includeSelf?: boolean }).includeSelf),
        })

        if (!agents.length) {
          return { content: [{ type: 'text', text: `No agents matched "${query}".` }] }
        }

        return {
          content: [{
            type: 'text',
            text: agents
              .map((agent, index) =>
                `${index + 1}. ${agent.email}${agent.summary ? ` — ${agent.summary}` : ''}`,
              )
              .join('\n'),
          }],
        }
      },
    }, { name: 'aamp_directory_search' })

    api.registerTool({
      name: 'aamp_send_result',
      description:
        'Send the result of an AAMP task back to the dispatcher. ' +
        'Call this after you have finished processing the task.',
      parameters: {
        type: 'object',
        required: ['taskId', 'status', 'output'],
        properties: {
          taskId: {
            type: 'string',
            description: 'The AAMP task ID to reply to (from the system context)',
          },
          status: {
            type: 'string',
            enum: ['completed', 'rejected'],
            description: '"completed" on success, "rejected" if the task cannot be done',
          },
          output: {
            type: 'string',
            description: 'Your result or explanation',
          },
          errorMsg: {
            type: 'string',
            description: 'Optional error details (use only when status = rejected)',
          },
          attachments: {
            type: 'array',
            description: 'File attachments. Each item: { filename, contentType, path (local file path) }',
            items: {
              type: 'object',
              properties: {
                filename: { type: 'string' },
                contentType: { type: 'string' },
                path: { type: 'string', description: 'Absolute path to the file on disk' },
              },
              required: ['filename', 'path'],
            },
          },
          structuredResult: {
            type: 'array',
            description: 'Optional structured Meego field values.',
            items: {
              type: 'object',
              required: ['fieldKey', 'fieldTypeKey'],
              properties: {
                fieldKey: { type: 'string' },
                fieldTypeKey: { type: 'string' },
                fieldAlias: { type: 'string' },
                value: {
                  description: 'Field value in the exact format required by Meego for this field type.',
                },
                index: { type: 'string' },
                attachmentFilenames: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'For attachment fields, filenames from attachments[] that should be uploaded into this field.',
                },
              },
            },
          },
        },
      },
      execute: async (_id, params) => {
        const p = params as {
          taskId: string
          status: 'completed' | 'rejected'
          output: string
          errorMsg?: string
          attachments?: Array<{ filename: string; contentType?: string; path: string }>
          structuredResult?: StructuredResultFieldInput[]
        }

        const task = pendingTasks.get(p.taskId)
        if (!task) {
          return {
            content: [{ type: 'text', text: `Error: task ${p.taskId} not found in pending queue.` }],
          }
        }

        if (!aampClient?.isConnected()) {
          return { content: [{ type: 'text', text: 'Error: AAMP client is not connected.' }] }
        }

        api.logger.info(`[AAMP] aamp_send_result params ${JSON.stringify({
          taskId: p.taskId,
          status: p.status,
          output: p.output,
          errorMsg: p.errorMsg,
          attachments: p.attachments?.map((a) => ({
            filename: a.filename,
            contentType: a.contentType ?? 'application/octet-stream',
            path: a.path,
          })) ?? [],
          structuredResult: p.structuredResult?.map((field) => ({
            fieldKey: field.fieldKey,
            fieldTypeKey: field.fieldTypeKey,
            fieldAlias: field.fieldAlias,
            value: field.value,
            index: field.index,
            attachmentFilenames: field.attachmentFilenames ?? [],
          })) ?? [],
        })}`)

        // Build attachments from file paths
        let attachments: AampAttachment[] | undefined
        if (p.attachments?.length) {
          attachments = p.attachments.map((a: { filename: string; contentType?: string; path: string }) => ({
            filename: a.filename,
            contentType: a.contentType ?? 'application/octet-stream',
            content: readBinaryFile(a.path),
          }))
        }

        await appendTaskStream(task.taskId, 'status', {
          state: 'completing',
          label: `Sending ${p.status} result`,
        })
        if (p.output) {
          await appendTaskStream(task.taskId, 'text.delta', { text: p.output })
        }
        await closeTaskStream(task.taskId, {
          reason: 'task.result',
          status: p.status,
          ...(p.errorMsg ? { error: p.errorMsg } : {}),
        })

        await aampClient.sendResult({
          to: task.from,
          taskId: task.taskId,
          status: p.status,
          output: p.output,
          errorMsg: p.errorMsg,
          structuredResult: p.structuredResult?.length ? p.structuredResult : undefined,
          inReplyTo: task.messageId || undefined,
          attachments,
        })

        pendingTasks.delete(task.taskId)
        rememberTerminalTask(task.taskId)
        api.logger.info(`[AAMP] → task.result  ${task.taskId}  ${p.status}`)

        // If more tasks remain, wake the agent to process them
        if (pendingTasks.size > 0) {
          try {
            api.runtime.system.requestHeartbeatNow({
              reason: 'wake',
              sessionKey: buildAampWakeSessionKey('queue', 'follow-up'),
            })
          } catch { /* ignore */ }
        }

        return {
          content: [
            {
              type: 'text',
              text: `Result sent for task ${task.taskId} (status: ${p.status}).`,
            },
          ],
        }
      },
    }, { name: 'aamp_send_result' })

    // ── 4. Tool: ask for help ─────────────────────────────────────────────────
    api.registerTool({
      name: 'aamp_send_help',
      description:
        'Send a help request for an AAMP task when you are blocked or need human clarification ' +
        'before you can proceed.',
      parameters: {
        type: 'object',
        required: ['taskId', 'question', 'blockedReason'],
        properties: {
          taskId: {
            type: 'string',
            description: 'The AAMP task ID',
          },
          question: {
            type: 'string',
            description: 'Your question for the human dispatcher',
          },
          blockedReason: {
            type: 'string',
            description: 'Why you cannot proceed without their input',
          },
          suggestedOptions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional list of choices for the dispatcher to pick from',
          },
        },
      },
      execute: async (_id, params) => {
        const p = params as {
          taskId: string
          question: string
          blockedReason: string
          suggestedOptions?: string[]
        }

        const task = pendingTasks.get(p.taskId)
        if (!task) {
          return {
            content: [{ type: 'text', text: `Error: task ${p.taskId} not found in pending queue.` }],
          }
        }

        if (!aampClient?.isConnected()) {
          return { content: [{ type: 'text', text: 'Error: AAMP client is not connected.' }] }
        }

        await appendTaskStream(task.taskId, 'status', {
          state: 'help_needed',
          label: p.blockedReason,
        })
        await closeTaskStream(task.taskId, {
          reason: 'task.help_needed',
        })

        await aampClient.sendHelp({
          to: task.from,
          taskId: task.taskId,
          question: p.question,
          blockedReason: p.blockedReason,
          suggestedOptions: p.suggestedOptions ?? [],
          inReplyTo: task.messageId || undefined,
        })

        api.logger.info(`[AAMP] → task.help_needed  ${task.taskId}`)

        // Keep the task in pending — the help reply may arrive later
        return {
          content: [
            {
              type: 'text',
              text: `Help request sent for task ${task.taskId}. The task remains pending until the dispatcher replies.`,
            },
          ],
        }
      },
    }, { name: 'aamp_send_help' })

    // ── 5. Tool: inspect queue ────────────────────────────────────────────────
    api.registerTool({
      name: 'aamp_pending_tasks',
      description: 'List all AAMP tasks currently waiting to be processed.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        if (pendingTasks.size === 0) {
          return { content: [{ type: 'text', text: 'No pending AAMP tasks.' }] }
        }

        const lines = [...pendingTasks.values()]
          .sort((a, b) => {
            const rankDiff = priorityRank(a.priority) - priorityRank(b.priority)
            if (rankDiff !== 0) return rankDiff
            return new Date(a.receivedAt).getTime() - new Date(b.receivedAt).getTime()
          })
          .map(
            (t, i) =>
              `${i + 1}. [${t.priority}] [${t.taskId}] "${t.title}"${t.bodyText ? `\n   Description: ${t.bodyText}` : ''} — from ${t.from} (received ${t.receivedAt})`,
          )

        return {
          content: [
            {
              type: 'text',
              text: `${pendingTasks.size} pending task(s):\n${lines.join('\n')}`,
            },
          ],
        }
      },
    }, { name: 'aamp_pending_tasks' })

    api.registerTool({
      name: 'aamp_cancel_task',
      description: 'Cancel a pending AAMP task and notify the dispatcher.',
      parameters: {
        type: 'object',
        required: ['taskId'],
        properties: {
          taskId: { type: 'string', description: 'The AAMP task ID to cancel.' },
          bodyText: { type: 'string', description: 'Optional cancellation note sent in the email body.' },
        },
      },
      execute: async (_id, params) => {
        const p = params as { taskId: string; bodyText?: string }
        const task = pendingTasks.get(p.taskId)
        if (!task) {
          return { content: [{ type: 'text', text: `Error: task ${p.taskId} not found in pending queue.` }] }
        }
        if (!aampClient?.isConnected()) {
          return { content: [{ type: 'text', text: 'Error: AAMP client is not connected.' }] }
        }

        await aampClient.sendCancel({
          to: task.from,
          taskId: task.taskId,
          bodyText: p.bodyText,
          inReplyTo: task.messageId || undefined,
        })

        pendingTasks.delete(task.taskId)
        rememberTerminalTask(task.taskId)
        api.logger.info(`[AAMP] → task.cancel  ${task.taskId}`)
        return {
          content: [{ type: 'text', text: `Cancellation sent for task ${task.taskId}.` }],
        }
      },
    }, { name: 'aamp_cancel_task' })

    // ── 6. Tool: dispatch task to another agent (SYNCHRONOUS) ───────────────────
    // Sends the task and BLOCKS until the sub-agent replies with task.result or
    // task.help_needed. The reply is returned directly as the tool result, keeping the
    // LLM awake with full context — no heartbeat/channel dispatch needed.
    api.registerTool({
      name: 'aamp_dispatch_task',
      description:
        'Send a task to another AAMP agent and WAIT for the result. ' +
        'This tool blocks until the sub-agent replies (typically 5-60s). ' +
        'The sub-agent\'s output and any attachment file paths are returned directly.',
      parameters: {
        type: 'object',
        required: ['to', 'title'],
        properties: {
          to: { type: 'string', description: 'Target agent AAMP email address' },
          title: { type: 'string', description: 'Task title (concise summary)' },
          bodyText: { type: 'string', description: 'Detailed task description' },
          parentTaskId: { type: 'string', description: 'If you are processing a pending AAMP task, pass its Task ID here to establish parent-child nesting. Omit for top-level tasks.' },
          priority: { type: 'string', enum: ['urgent', 'high', 'normal'], description: 'Task priority (optional)' },
          expiresAt: { type: 'string', description: 'Absolute expiry time in ISO 8601 format (optional)' },
          contextLinks: {
            type: 'array', items: { type: 'string' },
            description: 'URLs providing context (optional)',
          },
          attachments: {
            type: 'array',
            description: 'File attachments. Each item: { filename, contentType, path (local file path) }',
            items: {
              type: 'object',
              properties: {
                filename: { type: 'string' },
                contentType: { type: 'string' },
                path: { type: 'string', description: 'Absolute path to the file on disk' },
              },
              required: ['filename', 'path'],
            },
          },
        },
      },
      execute: async (_id: unknown, params: {
        to: string; title: string; bodyText?: string;
        parentTaskId?: string; priority?: TaskPriority; expiresAt?: string; contextLinks?: string[];
        attachments?: Array<{ filename: string; contentType?: string; path: string }>
      }) => {
        if (!aampClient?.isConnected()) {
          return { content: [{ type: 'text', text: 'Error: AAMP client is not connected.' }] }
        }

        try {
          // Build attachments from file paths
          let attachments: AampAttachment[] | undefined
          if (params.attachments?.length) {
            attachments = params.attachments.map((a: { filename: string; contentType?: string; path: string }) => ({
              filename: a.filename,
              contentType: a.contentType ?? 'application/octet-stream',
              content: readBinaryFile(a.path),
            }))
          }

          const result = await aampClient.sendTask({
            to: params.to,
            title: params.title,
            parentTaskId: params.parentTaskId,
            priority: params.priority,
            expiresAt: params.expiresAt,
            contextLinks: params.contextLinks,
            attachments,
          })

          // Track as dispatched sub-task
          dispatchedSubtasks.set(result.taskId, {
            to: params.to,
            title: params.title,
            dispatchedAt: new Date().toISOString(),
            parentTaskId: params.parentTaskId,
          })

          api.logger.info(`[AAMP] → task.dispatch  ${result.taskId}  to=${params.to}  parent=${params.parentTaskId ?? 'none'}  (waiting for reply…)`)

          // ── SYNCHRONOUS WAIT: block until sub-agent replies ──────────────
          const timeoutMs = params.expiresAt
            ? Math.max(new Date(params.expiresAt).getTime() - Date.now(), 1)
            : 300 * 1000
          const reply = await new Promise<{ type: 'result' | 'help'; data: unknown }>((resolve, reject) => {
            waitingDispatches.set(result.taskId, resolve)
            setTimeout(() => {
              if (waitingDispatches.delete(result.taskId)) {
                reject(new Error(
                  params.expiresAt
                    ? `Sub-task ${result.taskId} expired before a reply was received`
                    : `Sub-task ${result.taskId} timed out after 300s`,
                ))
              }
            }, timeoutMs)
          })

          api.logger.info(`[AAMP] ← sync reply for ${result.taskId}: type=${reply.type} attachments=${JSON.stringify((reply.data as any)?.attachments?.length ?? 0)}`)

          if (reply.type === 'result') {
            const r = reply.data as TaskResult

            // Pre-download attachments — use direct JMAP blob download (bypass SDK's downloadBlob
            // which was returning 404 due to URL construction issues in the esbuild bundle).
            let attachmentLines = ''
            if (r.attachments?.length) {
              api.logger.info(`[AAMP] Downloading ${r.attachments.length} attachment(s) from sync reply...`)
              const dir = '/tmp/aamp-files'
              ensureDir(dir)
              const downloaded: string[] = []
              const base = baseUrl(cfg.aampHost)
              const identity = loadCachedIdentity(cfg.credentialsFile ?? defaultCredentialsPath())
              const authHeader = identity ? `Basic ${Buffer.from(identity.email + ':' + identity.smtpPassword).toString('base64')}` : ''
              for (const att of r.attachments) {
                try {
                  // Direct JMAP blob download — construct URL manually
                  const dlUrl = `${base}/jmap/download/n/${encodeURIComponent(att.blobId)}/${encodeURIComponent(att.filename)}?accept=application/octet-stream`
                  api.logger.info(`[AAMP] Fetching ${dlUrl}`)
                  const dlRes = await fetch(dlUrl, { headers: { Authorization: authHeader } })
                  if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`)
                  const buffer = Buffer.from(await dlRes.arrayBuffer())
                  const filepath = `${dir}/${att.filename}`
                  writeBinaryFile(filepath, buffer)
                  downloaded.push(`${att.filename} (${(buffer.length / 1024).toFixed(1)} KB) → ${filepath}`)
                  api.logger.info(`[AAMP] Downloaded: ${att.filename} (${(buffer.length / 1024).toFixed(1)} KB)`)
                } catch (dlErr) {
                  api.logger.error(`[AAMP] Download failed for ${att.filename}: ${(dlErr as Error).message}`)
                }
              }
              if (downloaded.length) {
                attachmentLines = `\n\nAttachments downloaded:\n${downloaded.join('\n')}`
              }
            }

            return {
              content: [{
                type: 'text',
                text: [
                  `Sub-task ${r.status}: ${params.title}`,
                  `Agent: ${r.from}`,
                  `Task ID: ${result.taskId}`,
                  r.status === 'completed' ? `\nOutput:\n${r.output}` : `\nError: ${r.errorMsg ?? 'rejected'}`,
                  attachmentLines,
                ].filter(Boolean).join('\n'),
              }],
            }
          } else {
            const h = reply.data as TaskHelp
            return {
              content: [{
                type: 'text',
                text: [
                  `Sub-task needs help: ${params.title}`,
                  `Agent: ${h.from}`,
                  `Task ID: ${result.taskId}`,
                  `\nQuestion: ${h.question}`,
                  `Blocked reason: ${h.blockedReason}`,
                  h.suggestedOptions?.length ? `Options: ${h.suggestedOptions.join(' | ')}` : '',
                ].filter(Boolean).join('\n'),
              }],
            }
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error dispatching task: ${(err as Error).message}` }],
          }
        }
      },
    }, { name: 'aamp_dispatch_task' })

    // ── 7. Tool: check AAMP protocol support ──────────────────────────────────
    api.registerTool({
      name: 'aamp_check_protocol',
      description:
        'Check if an email address supports the AAMP protocol. ' +
        'Returns { aamp: true/false } indicating whether the address is an AAMP agent.',
      parameters: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', description: 'Email address to check' },
        },
      },
      execute: async (_id: unknown, params: { email: string }) => {
        const base = baseUrl(cfg.aampHost)
        const email = params?.email ?? ''
        if (!email) {
          return { content: [{ type: 'text', text: 'Error: email parameter is required' }] }
        }
        try {
          const discoveryRes = await fetch(`${base}/.well-known/aamp`)
          if (!discoveryRes.ok) throw new Error(`HTTP ${discoveryRes.status}`)
          const discovery = await discoveryRes.json() as { api?: { url?: string } }
          const apiUrl = discovery.api?.url
          if (!apiUrl) throw new Error('AAMP discovery did not return api.url')
          const apiBase = new URL(apiUrl, `${base}/`).toString()
          const res = await fetch(`${apiBase}?action=aamp.mailbox.check&email=${encodeURIComponent(email)}`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          const data = await res.json() as { aamp: boolean; domain?: string }
          return {
            content: [{
              type: 'text',
              text: data.aamp
                ? `${params.email} supports AAMP protocol (domain: ${data.domain ?? 'unknown'})`
                : `${params.email} does not support AAMP protocol`,
            }],
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Could not check ${params.email}: ${(err as Error).message}` }],
          }
        }
      },
    }, { name: 'aamp_check_protocol' })

    // ── 8. Tool: download attachment blob ─────────────────────────────────────
    api.registerTool({
      name: 'aamp_download_attachment',
      description:
        'Download an AAMP email attachment to local disk by its blobId. ' +
        'Use this to retrieve files received from sub-agent task results.',
      parameters: {
        type: 'object',
        required: ['blobId', 'filename'],
        properties: {
          blobId: { type: 'string', description: 'The JMAP blobId from the attachment metadata' },
          filename: { type: 'string', description: 'Filename to save as' },
          saveTo: { type: 'string', description: 'Directory to save to (default: /tmp/aamp-files)' },
        },
      },
      execute: async (_id: unknown, params: { blobId: string; filename: string; saveTo?: string }) => {
        if (!aampClient?.isConnected()) {
          return { content: [{ type: 'text', text: 'Error: AAMP client is not connected.' }] }
        }

        const dir = params.saveTo ?? '/tmp/aamp-files'
        ensureDir(dir)

        try {
          const buffer = await aampClient.downloadBlob(params.blobId, params.filename)
          const filepath = `${dir}/${params.filename}`
          writeBinaryFile(filepath, buffer)
          return {
            content: [{
              type: 'text',
              text: `Downloaded ${params.filename} (${(buffer.length / 1024).toFixed(1)} KB) to ${filepath}`,
            }],
          }
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Download failed: ${(err as Error).message}` }],
          }
        }
      },
    }, { name: 'aamp_download_attachment' })

    // ── 9. Slash command: /aamp-status ────────────────────────────────────────
    api.registerCommand({
      name: 'aamp-status',
      description: 'Show AAMP connection status and pending task queue',
      acceptsArgs: false,
      requireAuth: false,
      handler: () => {
        const isPollingFallback = aampClient?.isUsingPollingFallback?.() ?? false
        const connectionLine = aampClient?.isConnected()
          ? (isPollingFallback ? '🟡 connected (polling fallback)' : '✅ connected')
          : '❌ disconnected'

        return {
          text: [
          `**AAMP Plugin Status**`,
          `Host:       ${cfg.aampHost || '(not configured)'}`,
          `Identity:   ${agentEmail || '(not yet registered)'}`,
          `Connection: ${connectionLine}`,
          `Cached:     ${loadCachedIdentity(cfg.credentialsFile ?? defaultCredentialsPath()) ? 'yes' : 'no'}`,
          lastConnectionError ? `Last error: ${lastConnectionError}` : '',
          lastDisconnectReason ? `Last disconnect: ${lastDisconnectReason}` : '',
          `Pending:    ${pendingTasks.size} task(s)`,
          ...[...pendingTasks.values()].map(
            (t) => `  • ${t.taskId.slice(0, 8)}… "${t.title}" from ${t.from}`,
          ),
          ]
            .filter(Boolean)
            .join('\n'),
        }
      },
    })
  },
}
