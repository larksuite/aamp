/**
 * AAMP SDK Type Definitions
 */

export type AampIntent = 'task.dispatch' | 'task.result' | 'task.help' | 'task.ack'

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'timeout'
  | 'help_needed'

// =====================================================
// AAMP Header constants
// =====================================================
export const AAMP_HEADER = {
  INTENT: 'X-AAMP-Intent',
  TASK_ID: 'X-AAMP-TaskId',
  TIMEOUT: 'X-AAMP-Timeout',
  CONTEXT_LINKS: 'X-AAMP-ContextLinks',
  DISPATCH_CONTEXT: 'X-AAMP-Dispatch-Context',
  STATUS: 'X-AAMP-Status',
  OUTPUT: 'X-AAMP-Output',
  ERROR_MSG: 'X-AAMP-ErrorMsg',
  STRUCTURED_RESULT: 'X-AAMP-StructuredResult',
  QUESTION: 'X-AAMP-Question',
  BLOCKED_REASON: 'X-AAMP-BlockedReason',
  SUGGESTED_OPTIONS: 'X-AAMP-SuggestedOptions',
  PARENT_TASK_ID: 'X-AAMP-ParentTaskId',
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
  intent: 'task.dispatch'
  taskId: string
  title: string
  timeoutSecs: number
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

// =====================================================
// Parsed AAMP headers for task.result
// =====================================================
export interface TaskResult {
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
// Parsed AAMP headers for task.help
// =====================================================
export interface TaskHelp {
  intent: 'task.help'
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
  intent: 'task.ack'
  taskId: string
  from: string
  to: string
  messageId?: string
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

export type AampMessage = TaskDispatch | TaskResult | TaskHelp | TaskAck | HumanReply

// =====================================================
// SDK Configuration
// =====================================================
export interface AampClientConfig {
  /** Node email address, e.g. codereviewer-abc123@aamp.yourdomain.com */
  email: string

  /** Base64(email:smtpPassword) — returned by management service on agent creation */
  jmapToken: string

  /** Stalwart base URL, e.g. http://localhost:8080 */
  jmapUrl: string

  /** Optional HTTP send base URL. Defaults to jmapUrl and is used for same-domain send fallback via /api/send. */
  httpSendBaseUrl?: string

  /** SMTP submission host */
  smtpHost: string

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

// =====================================================
// Options for sending emails
// =====================================================
export interface SendTaskOptions {
  /** Target node email */
  to: string
  title: string
  bodyText?: string
  timeoutSecs?: number
  contextLinks?: string[]
  dispatchContext?: Record<string, string>
  parentTaskId?: string
  /** Attachments to include with the dispatch email */
  attachments?: AampAttachment[]
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

// =====================================================
// Event emitter types
// =====================================================
export interface AampClientEvents {
  'task.dispatch': (task: TaskDispatch) => void
  'task.result': (result: TaskResult) => void
  'task.help': (help: TaskHelp) => void
  'task.ack': (ack: TaskAck) => void
  /** Emitted when a standard email reply (no X-AAMP headers) is received for a known thread.
   *  Use inReplyTo to look up the taskId in your own store (Redis / DB). */
  'reply': (reply: HumanReply) => void
  connected: () => void
  disconnected: (reason: string) => void
  error: (err: Error) => void
}
