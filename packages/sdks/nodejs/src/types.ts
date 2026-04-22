/**
 * AAMP SDK Type Definitions
 */

export const AAMP_PROTOCOL_VERSION = '1.1'

export type AampIntent =
  | 'task.dispatch'
  | 'task.cancel'
  | 'task.result'
  | 'task.help_needed'
  | 'task.ack'
  | 'task.stream.opened'
  | 'card.query'
  | 'card.response'

export type TaskPriority = 'urgent' | 'high' | 'normal'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'help_needed'
  | 'cancelled'
  | 'expired'

// =====================================================
// AAMP Header constants
// =====================================================
export const AAMP_HEADER = {
  VERSION: 'X-AAMP-Version',
  INTENT: 'X-AAMP-Intent',
  TASK_ID: 'X-AAMP-TaskId',
  CONTEXT_LINKS: 'X-AAMP-ContextLinks',
  DISPATCH_CONTEXT: 'X-AAMP-Dispatch-Context',
  PRIORITY: 'X-AAMP-Priority',
  EXPIRES_AT: 'X-AAMP-Expires-At',
  STATUS: 'X-AAMP-Status',
  OUTPUT: 'X-AAMP-Output',
  ERROR_MSG: 'X-AAMP-ErrorMsg',
  STRUCTURED_RESULT: 'X-AAMP-StructuredResult',
  QUESTION: 'X-AAMP-Question',
  BLOCKED_REASON: 'X-AAMP-BlockedReason',
  SUGGESTED_OPTIONS: 'X-AAMP-SuggestedOptions',
  STREAM_ID: 'X-AAMP-Stream-Id',
  PARENT_TASK_ID: 'X-AAMP-ParentTaskId',
  CARD_SUMMARY: 'X-AAMP-Card-Summary',
} as const

export interface StructuredResultField {
  fieldKey: string
  fieldTypeKey: string
  value?: unknown
  fieldAlias?: string
  index?: string
  attachmentFilenames?: string[]
}

// =====================================================
// Parsed AAMP headers for task.dispatch
// =====================================================
export interface TaskDispatch {
  protocolVersion: string
  intent: 'task.dispatch'
  taskId: string
  title: string
  priority: TaskPriority
  expiresAt?: string
  contextLinks: string[]
  dispatchContext?: Record<string, string>
  parentTaskId?: string
  // Email metadata
  from: string
  to: string
  messageId: string
  subject: string
  /** Plain-text body of the email (task description) */
  bodyText: string
  /** Attachments received with this dispatch (use blobId to download) */
  attachments?: ReceivedAttachment[]
}

export interface TaskCancel {
  protocolVersion: string
  intent: 'task.cancel'
  taskId: string
  from: string
  to: string
  messageId?: string
  subject: string
  bodyText: string
}

// =====================================================
// Parsed AAMP headers for task.result
// =====================================================
export interface TaskResult {
  protocolVersion: string
  intent: 'task.result'
  taskId: string
  status: 'completed' | 'rejected'
  output: string
  errorMsg?: string
  structuredResult?: StructuredResultField[]
  from: string
  to: string
  messageId?: string
  /** True when the reply came from a standard email client (no X-AAMP-Intent header).
   *  taskId was resolved via In-Reply-To → Message-ID reverse lookup. */
  isHumanReply?: boolean
  /** Attachments received with this result (use blobId to download) */
  attachments?: ReceivedAttachment[]
}

// =====================================================
// Human reply via standard email client (no AAMP headers)
// Emitted as 'reply' event when an email has In-Reply-To but no X-AAMP-Intent.
// The application layer is responsible for resolving inReplyTo → taskId
// (e.g. via Redis reverse index) and deciding how to handle it.
// =====================================================
export interface HumanReply {
  /** Message-ID of the email being replied to — use this to look up the taskId */
  inReplyTo: string
  /** This reply email's own Message-ID */
  messageId: string
  from: string
  to: string
  subject: string
  /** Plain-text body of the reply */
  bodyText: string
}

// =====================================================
// Parsed AAMP headers for task.help_needed
// =====================================================
export interface TaskHelp {
  protocolVersion: string
  intent: 'task.help_needed'
  taskId: string
  question: string
  blockedReason: string
  suggestedOptions: string[]
  from: string
  to: string
  messageId?: string
}

// =====================================================
// Parsed AAMP headers for task.ack
// =====================================================
export interface TaskAck {
  protocolVersion: string
  intent: 'task.ack'
  taskId: string
  from: string
  to: string
  messageId?: string
}

export interface TaskStreamOpened {
  protocolVersion: string
  intent: 'task.stream.opened'
  taskId: string
  streamId: string
  from: string
  to: string
  messageId?: string
}

export interface CardQuery {
  protocolVersion: string
  intent: 'card.query'
  taskId: string
  from: string
  to: string
  messageId?: string
  subject: string
  bodyText: string
}

export interface CardResponse {
  protocolVersion: string
  intent: 'card.response'
  taskId: string
  summary: string
  from: string
  to: string
  messageId?: string
  subject: string
  bodyText: string
}

// =====================================================
// Attachment types
// =====================================================

/** Attachment for sending (binary content) */
export interface AampAttachment {
  filename: string
  contentType: string
  content: Buffer | string  // Buffer for binary, base64 string for REST API
  size?: number
}

/** Attachment metadata received via JMAP (use blobId to download) */
export interface ReceivedAttachment {
  filename: string
  contentType: string
  size: number
  blobId: string
}

export type AampMessage =
  | TaskDispatch
  | TaskCancel
  | TaskResult
  | TaskHelp
  | TaskAck
  | TaskStreamOpened
  | CardQuery
  | CardResponse
  | HumanReply

// =====================================================
// SDK Configuration
// =====================================================
export interface AampClientConfig {
  /** Node email address, e.g. codereviewer-abc123@aamp.yourdomain.com */
  email: string

  /** Mailbox token for HTTP Basic Auth. Equivalent to base64(email:smtpPassword). */
  mailboxToken: string

  /** Base URL for this mailbox service, e.g. https://meshmail.ai */
  baseUrl: string

  /** Optional AAMP discovery base URL. Defaults to baseUrl and is used for same-domain send fallback via /.well-known/aamp + aamp.mailbox.send. */
  httpSendBaseUrl?: string

  /** SMTP submission host. If omitted, derived from baseUrl. */
  smtpHost?: string

  /** SMTP submission port (default: 587) */
  smtpPort?: number

  /** SMTP password (returned by management service on agent creation) */
  smtpPassword: string

  /** How often to retry failed JMAP connection (ms, default: 5000) */
  reconnectInterval?: number

  /** Whether to reject unauthorized TLS certificates (default: true).
   *  Set to false only for development with self-signed certificates. */
  rejectUnauthorized?: boolean
}

export interface AampMailboxIdentityConfig {
  /** Mailbox email address, e.g. agent@meshmail.ai */
  email: string

  /** Mailbox SMTP/JMAP password */
  smtpPassword: string

  /** Optional base URL for JMAP and same-domain AAMP HTTP send fallback.
   *  Defaults to https://<email-domain>. */
  baseUrl?: string

  /** SMTP submission port (default: 587) */
  smtpPort?: number

  /** How often to retry failed JMAP connection (ms, default: 5000) */
  reconnectInterval?: number

  /** Whether to reject unauthorized TLS certificates (default: true). */
  rejectUnauthorized?: boolean
}

export interface AampDiscoveryDocument {
  protocol: 'aamp'
  version: string
  intents?: AampIntent[]
  api?: {
    url?: string
    actions?: string[]
  }
  endpoints?: Record<string, string>
  capabilities?: {
    stream?: {
      transport: 'sse'
      createAction?: string
      appendAction?: string
      closeAction?: string
      getAction?: string
      subscribeUrlTemplate?: string
    }
  }
}

export interface RegisterMailboxOptions {
  /** AAMP service root, e.g. https://meshmail.ai */
  aampHost: string
  slug: string
  description?: string
}

export interface RegisteredMailboxIdentity {
  email: string
  mailboxToken: string
  smtpPassword: string
  baseUrl: string
}

export interface AgentDirectoryEntry {
  email: string
  summary: string | null
}

export interface AgentDirectorySearchEntry extends AgentDirectoryEntry {
  score: number
}

export interface AgentDirectoryProfile extends AgentDirectoryEntry {
  cardText: string | null
}

export interface AampThreadEvent {
  intent: AampIntent
  from: string
  to: string
  title?: string | null
  bodyText?: string | null
  output?: string | null
  question?: string | null
  blockedReason?: string | null
  messageId?: string | null
  createdAt: string
}

export interface GetThreadHistoryOptions {
  includeStreamOpened?: boolean
}

export interface TaskThreadHistory {
  taskId: string
  events: AampThreadEvent[]
}

export interface HydratedTaskDispatch extends TaskDispatch {
  threadHistory: AampThreadEvent[]
  threadContextText: string
}

// =====================================================
// Options for sending emails
// =====================================================
export interface SendTaskOptions {
  /** Target node email */
  to: string
  taskId?: string
  title: string
  bodyText?: string
  priority?: TaskPriority
  /** Absolute expiry timestamp. */
  expiresAt?: string
  contextLinks?: string[]
  dispatchContext?: Record<string, string>
  parentTaskId?: string
  /** Attachments to include with the dispatch email */
  attachments?: AampAttachment[]
}

export interface SendCancelOptions {
  to: string
  taskId: string
  bodyText?: string
  inReplyTo?: string
}

export interface SendResultOptions {
  /** Send to: the original from address of the dispatch email */
  to: string
  taskId: string
  status: 'completed' | 'rejected'
  output: string
  errorMsg?: string
  structuredResult?: StructuredResultField[]
  /** Message-ID of the dispatch email, for In-Reply-To threading */
  inReplyTo?: string
  /** Attachments to include with the result email */
  attachments?: AampAttachment[]
}

export interface SendHelpOptions {
  /** Send to: the original from address of the dispatch email */
  to: string
  taskId: string
  question: string
  blockedReason: string
  suggestedOptions: string[]
  /** Message-ID of the dispatch email, for In-Reply-To threading */
  inReplyTo?: string
  /** Attachments to include with the help email */
  attachments?: AampAttachment[]
}

export interface SendCardQueryOptions {
  to: string
  taskId?: string
  bodyText?: string
  inReplyTo?: string
}

export interface SendCardResponseOptions {
  to: string
  taskId: string
  summary: string
  bodyText: string
  inReplyTo?: string
}

export interface CreateStreamOptions {
  taskId: string
  peerEmail: string
}

export interface CreateStreamResult {
  streamId: string
  taskId: string
  status: 'created' | 'opened' | 'closed'
  ownerEmail: string
  peerEmail: string
  createdAt: string
  openedAt?: string
  closedAt?: string
}

export type AampStreamEventType =
  | 'text.delta'
  | 'progress'
  | 'status'
  | 'artifact'
  | 'error'
  | 'done'

export interface AampStreamEvent {
  id?: string
  streamId: string
  taskId: string
  seq: number
  timestamp: string
  type: AampStreamEventType
  payload: Record<string, unknown>
}

export interface AppendStreamEventOptions {
  streamId: string
  type: AampStreamEventType
  payload: Record<string, unknown>
}

export interface CloseStreamOptions {
  streamId: string
  payload?: Record<string, unknown>
}

export interface GetTaskStreamOptions {
  taskId?: string
  streamId?: string
}

export interface TaskStreamState extends CreateStreamResult {
  latestEvent?: AampStreamEvent
}

export interface StreamSubscription {
  close(): void
}

export interface DirectoryListOptions {
  scope?: string
  includeSelf?: boolean
  limit?: number
}

export interface DirectorySearchOptions extends DirectoryListOptions {
  query: string
}

export interface UpdateDirectoryProfileOptions {
  summary?: string | null
  cardText?: string | null
}

// =====================================================
// Event emitter types
// =====================================================
export interface AampClientEvents {
  'task.dispatch': (task: TaskDispatch) => void
  'task.cancel': (task: TaskCancel) => void
  'task.result': (result: TaskResult) => void
  'task.help_needed': (help: TaskHelp) => void
  'task.ack': (ack: TaskAck) => void
  'task.stream.opened': (stream: TaskStreamOpened) => void
  'card.query': (query: CardQuery) => void
  'card.response': (response: CardResponse) => void
  /** Emitted when a standard email reply (no X-AAMP headers) is received for a known thread.
   *  Use inReplyTo to look up the taskId in your own store (Redis / DB). */
  'reply': (reply: HumanReply) => void
  connected: () => void
  disconnected: (reason: string) => void
  error: (err: Error) => void
}
