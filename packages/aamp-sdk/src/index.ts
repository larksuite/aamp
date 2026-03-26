/**
 * aamp-sdk — Node.js SDK for AAMP Service
 *
 * Main exports:
 * - AampClient: combined JMAP push receiver + SMTP sender
 * - parseAampHeaders: parse AAMP headers from raw email headers
 * - Types
 */

export { AampClient } from './client.js'
export {
  parseAampHeaders,
  normalizeHeaders,
  buildDispatchHeaders,
  buildResultHeaders,
  buildHelpHeaders,
  buildAckHeaders,
  parseDispatchContextHeader,
  serializeDispatchContextHeader,
} from './parser.js'
export { JmapPushClient } from './jmap-push.js'
export { SmtpSender } from './smtp-sender.js'

// Types
export type {
  AampIntent,
  TaskStatus,
  AampAttachment,
  ReceivedAttachment,
  StructuredResultField,
  TaskDispatch,
  TaskResult,
  TaskHelp,
  TaskAck,
  HumanReply,
  AampMessage,
  AampClientConfig,
  AampClientEvents,
  SendTaskOptions,
  SendResultOptions,
  SendHelpOptions,
} from './types.js'

export { AAMP_HEADER } from './types.js'
