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
  summary?: string
  mailbox: BridgeMailboxIdentity
  wechat: {
    apiBaseUrl: string
    botType: string
    botAgent: string
  }
  behavior: {
    dispatchTimeoutMs: number
    pollTimeoutMs: number
  }
}

export interface LoggedInWechatAccount {
  accountId: string
  token: string
  baseUrl: string
  ilinkUserId?: string
  connectedAt: string
}

export interface BridgeConversationState {
  senderId: string
  sessionKey: string
  lastTaskId?: string
  lastContextToken?: string
  updatedAt: string
}

export interface BridgeTaskState {
  taskId: string
  senderId: string
  sessionKey: string
  contextToken?: string
  status: 'received' | 'pending' | 'streaming' | 'help_needed' | 'completed' | 'rejected' | 'failed'
  createdAt: string
  updatedAt: string
  streamId?: string
  streamText?: string
  outputText?: string
  resultError?: string
  typingActive?: boolean
}

export interface BridgeState {
  version: 1
  account?: LoggedInWechatAccount
  syncCursor?: string
  lastLoginAt?: string
  lastStartedAt?: string
  lastStoppedAt?: string
  lastError?: string
  processedMessageIds: string[]
  contextTokens: Record<string, string>
  conversations: Record<string, BridgeConversationState>
  tasks: Record<string, BridgeTaskState>
}
