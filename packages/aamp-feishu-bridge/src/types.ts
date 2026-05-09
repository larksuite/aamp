export interface BridgeMailboxIdentity {
  email: string
  mailboxToken: string
  smtpPassword: string
  baseUrl: string
}

export interface BridgeConfig {
  version: 1
  aampHost: string
  targetAgentEmail: string
  slug: string
  feishu: {
    appId: string
    appSecret: string
    domain?: string
  }
  mailbox: BridgeMailboxIdentity
  behavior: {
    streamThrottleMs: number
    streamThrottleChars: number
  }
}

export type BridgeChatType = 'p2p' | 'group'

export type BridgeTaskStatus =
  | 'dispatching'
  | 'pending'
  | 'streaming'
  | 'help_needed'
  | 'completed'
  | 'rejected'
  | 'failed'

export interface BridgeConversationState {
  threadKey: string
  chatId: string
  chatType: BridgeChatType
  senderId: string
  senderName?: string
  lastTaskId: string
  lastBridgeMessageId?: string
  updatedAt: string
}

export interface BridgeTaskState {
  taskId: string
  threadKey: string
  chatId: string
  chatType: BridgeChatType
  senderId: string
  senderName?: string
  userMessageId: string
  userMessageText: string
  bridgeMessageId?: string
  dispatchMessageId?: string
  streamId?: string
  lastStreamEventId?: string
  receivedReactionId?: string
  ackReactionId?: string
  targetAgentEmail: string
  status: BridgeTaskStatus
  title: string
  outputText: string
  streamText?: string
  statusLabel?: string
  progressLabel?: string
  helpQuestion?: string
  blockedReason?: string
  helpSuggestedOptions?: string[]
  helpCardMessageId?: string
  parentTaskId?: string
  resultError?: string
  createdAt: string
  updatedAt: string
}

export interface BridgeState {
  version: 1
  lastStartedAt?: string
  lastStoppedAt?: string
  lastError?: string
  bot?: {
    openId?: string
    name?: string
  }
  connectivity: {
    feishu: 'disconnected' | 'connecting' | 'connected'
    aamp: 'disconnected' | 'connecting' | 'connected'
  }
  conversations: Record<string, BridgeConversationState>
  tasks: Record<string, BridgeTaskState>
  dedupMessageIds: Record<string, string>
}
