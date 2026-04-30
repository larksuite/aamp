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
  buildCancelHeaders,
  buildResultHeaders,
  buildHelpHeaders,
  buildAckHeaders,
  buildStreamOpenedHeaders,
  buildCardQueryHeaders,
  buildCardResponseHeaders,
  parseDispatchContextHeader,
  serializeDispatchContextHeader,
} from './parser.js'
export { JmapPushClient } from './jmap-push.js'
export { SmtpSender, deriveMailboxServiceDefaults } from './smtp-sender.js'
export { renderThreadHistoryForAgent } from './thread.js'

// Types
export type {
  AampIntent,
  TaskStatus,
  AampAttachment,
  ReceivedAttachment,
  StructuredResultField,
  TaskDispatch,
  TaskCancel,
  TaskResult,
  TaskHelp,
  TaskAck,
  TaskStreamOpened,
  CardQuery,
  CardResponse,
  HumanReply,
  AampStreamEvent,
  AppendStreamEventOptions,
  CreateStreamOptions,
  CreateStreamResult,
  CloseStreamOptions,
  TaskStreamState,
  StreamSubscription,
  AgentDirectoryEntry,
  AgentDirectorySearchEntry,
  AgentDirectoryProfile,
  AampThreadEvent,
  AampMessage,
  AampClientConfig,
  AampMailboxIdentityConfig,
  AampDiscoveryDocument,
  GetThreadHistoryOptions,
  HydratedTaskDispatch,
  RegisterMailboxOptions,
  RegisteredMailboxIdentity,
  RegisteredCommandDispatchPayload,
  RegisteredCommandInputRef,
  RegisteredCommandStreamMode,
  AampClientEvents,
  SendRegisteredCommandOptions,
  SendTaskOptions,
  SendCancelOptions,
  SendResultOptions,
  SendHelpOptions,
  SendCardQueryOptions,
  SendCardResponseOptions,
  GetTaskStreamOptions,
  DirectoryListOptions,
  DirectorySearchOptions,
  TaskThreadHistory,
  UpdateDirectoryProfileOptions,
} from './types.js'

export { AAMP_HEADER, AAMP_PROTOCOL_VERSION } from './types.js'
