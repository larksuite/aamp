import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Readable } from 'node:stream'
import {
  AampClient,
  type AampAttachment,
  type AampStreamEvent,
  type StreamSubscription,
  type TaskAck,
  type TaskHelp,
  type TaskResult,
  type TaskStreamOpened,
  type ReceivedAttachment,
} from 'aamp-sdk'
import {
  LoggerLevel,
  type BotIdentity,
  type CardActionEvent,
  createLarkChannel,
  type LarkChannel,
  type NormalizedMessage,
  type ResourceDescriptor,
} from '@larksuiteoapi/node-sdk'
import {
  createDefaultBridgeState,
  loadBridgeState,
  saveBridgeState,
} from './config.js'
import { LarkCliChannel } from './lark-cli-channel.js'
import type {
  BridgeConfig,
  BridgeConversationState,
  BridgeStreamCursor,
  BridgeStreamEntry,
  BridgeState,
  BridgeTaskState,
  BridgeToolTraceItem,
} from './types.js'

interface BridgeRuntimeOptions {
  configDir?: string
  logger?: Pick<Console, 'log' | 'error'>
}

interface SenderRawEvent {
  sender?: {
    tenant_key?: string
  }
}

interface FeishuCardSession {
  messageId?: string
  cardId?: string
  closed: boolean
  currentCard: Record<string, unknown>
  ready: Promise<void>
  result: Promise<void>
  update(nextCard: Record<string, unknown>): Promise<void>
  close(finalCard?: Record<string, unknown>): Promise<void>
  abandon(): void
}

interface DispatchReplyTarget {
  chatId: string
  replyTo?: string
  replyInThread?: boolean
}

interface PreparedAttachments {
  attachments: AampAttachment[]
  notes: string[]
}

interface RepliedMessageContext {
  messageId: string
  senderId?: string
  createTime?: number
  rawContentType: string
  content: string
  resources: ResourceDescriptor[]
  notes: string[]
}

interface DownloadedResource {
  content: Buffer
  contentType?: string
}

interface ResultAttachmentSendOutcome {
  sent: string[]
  failed: string[]
}

interface MarkdownElementContent {
  elementId: string
  content: string
}

const RECEIVED_REACTION_CANDIDATES = ['Get']
const TYPING_REACTION_CANDIDATES = ['Typing']
const CARD_STREAM_PRINT_FREQUENCY_MS = {
  default: 30,
  android: 30,
  ios: 35,
  pc: 30,
}
const CARD_STREAM_PRINT_STEP = {
  default: 8,
  android: 8,
  ios: 8,
  pc: 8,
}

function isTerminalTaskStatus(status: BridgeTaskState['status']): boolean {
  return status === 'completed'
    || status === 'rejected'
    || status === 'failed'
}

export class FeishuBridgeRuntime {
  private readonly aamp: AampClient
  private readonly channel: LarkChannel | LarkCliChannel
  private readonly config: BridgeConfig
  private readonly configDir?: string
  private readonly logger: Pick<Console, 'log' | 'error'>
  private state: BridgeState = createDefaultBridgeState()
  private readonly activeStreamSubscriptions = new Map<string, StreamSubscription>()
  private readonly cardSessions = new Map<string, FeishuCardSession>()
  private readonly streamCardUpdateChains = new Map<string, Promise<void>>()
  private readonly liveTaskIds = new Set<string>()
  private stopping = false

  constructor(config: BridgeConfig, options: BridgeRuntimeOptions = {}) {
    this.config = config
    this.configDir = options.configDir
    this.logger = options.logger ?? console
    this.aamp = new AampClient({
      email: config.mailbox.email,
      mailboxToken: config.mailbox.mailboxToken,
      smtpPassword: config.mailbox.smtpPassword,
      baseUrl: config.mailbox.baseUrl,
    })
    this.channel = (config.feishu.authMode ?? 'app-secret') === 'lark-cli'
      ? new LarkCliChannel({
        cliBin: config.feishu.cliBin ?? 'lark-cli',
        profile: config.feishu.cliProfile ?? config.slug,
        logger: this.logger,
      })
      : createLarkChannel({
        appId: config.feishu.appId,
        appSecret: config.feishu.appSecret ?? '',
        transport: 'websocket',
        loggerLevel: LoggerLevel.info,
        domain: config.feishu.domain,
        source: 'aamp-feishu-bridge',
        includeRawEvent: true,
        outbound: {
          streamThrottleMs: config.behavior.streamThrottleMs,
          streamThrottleChars: config.behavior.streamThrottleChars,
        },
      })
  }

  async start(): Promise<void> {
    this.state = await loadBridgeState(this.configDir)
    this.restoreLiveTasksFromState()
    this.state.lastStartedAt = new Date().toISOString()
    this.state.lastError = undefined
    this.setConnectivity('aamp', 'connecting')
    this.setConnectivity('feishu', 'connecting')

    this.registerAampHandlers()
    this.registerFeishuHandlers()

    await this.aamp.connect()
    this.setConnectivity('aamp', 'connected')
    await this.channel.connect()
    this.setConnectivity('feishu', 'connected')
    this.captureBotIdentity()
    await this.resumeActiveStreams()
    await this.reconcileRecentMailbox(true)
    await this.aamp.updateDirectoryProfile({
      summary: `Feishu bridge mailbox for ${this.config.targetAgentEmail}`,
      cardText: `This mailbox belongs to a local Feishu bridge.\nTarget AAMP Agent: ${this.config.targetAgentEmail}`,
    }).catch(() => {})
    await this.persistState()
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true

    for (const subscription of this.activeStreamSubscriptions.values()) {
      subscription.close()
    }
    this.activeStreamSubscriptions.clear()

    for (const session of this.cardSessions.values()) {
      await session.close().catch(() => {})
    }
    this.cardSessions.clear()

    await this.channel.disconnect().catch(() => {})
    this.aamp.disconnect()
    this.state.lastStoppedAt = new Date().toISOString()
    this.setConnectivity('aamp', 'disconnected')
    this.setConnectivity('feishu', 'disconnected')
    await this.persistState()
  }

  getStateSnapshot(): BridgeState {
    return structuredClone(this.state)
  }

  private registerAampHandlers(): void {
    this.aamp.on('connected', () => {
      this.setConnectivity('aamp', 'connected')
      void this.persistState()
    })
    this.aamp.on('disconnected', () => {
      this.setConnectivity('aamp', 'disconnected')
      void this.persistState()
    })
    this.aamp.on('error', (error) => {
      this.state.lastError = error.message
      this.logger.error(`[aamp] ${error.message}`)
      void this.persistState()
    })
    this.aamp.on('task.ack', (task) => {
      void this.handleTaskAck(task)
    })
    this.aamp.on('task.stream.opened', (task) => {
      void this.handleTaskStreamOpened(task)
    })
    this.aamp.on('task.result', (task) => {
      void this.handleTaskResult(task)
    })
    this.aamp.on('task.help_needed', (task) => {
      void this.handleTaskHelp(task)
    })
  }

  private registerFeishuHandlers(): void {
    const channel = this.channel as {
      on(name: 'message', handler: (message: NormalizedMessage) => void): void
      on(name: 'cardAction', handler: (event: CardActionEvent) => void): void
      on(name: 'error', handler: (error: Error) => void): void
      on(name: 'reconnecting', handler: () => void): void
      on(name: 'reconnected', handler: () => void): void
    }
    channel.on('message', (message: NormalizedMessage) => {
      void this.handleIncomingMessage(message).catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[feishu->aamp] ${error.message}`)
        void this.persistState()
      })
    })
    channel.on('cardAction', (event: CardActionEvent) => {
      void this.handleCardAction(event).catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[feishu card] ${error.message}`)
        void this.persistState()
      })
    })
    channel.on('error', (error: Error) => {
      this.state.lastError = error.message
      this.logger.error(`[feishu] ${error.message}`)
      void this.persistState()
    })
    channel.on('reconnecting', () => {
      this.setConnectivity('feishu', 'connecting')
      void this.persistState()
    })
    channel.on('reconnected', () => {
      this.setConnectivity('feishu', 'connected')
      this.captureBotIdentity()
      void this.persistState()
    })
  }

  private captureBotIdentity(): void {
    const bot = this.channel.botIdentity
    if (!bot) return
    this.state.bot = {
      openId: bot.openId,
      name: bot.name,
    }
  }

  private async handleIncomingMessage(message: NormalizedMessage): Promise<void> {
    const botIdentity = this.channel.botIdentity
    if (botIdentity && message.senderId === botIdentity.openId) return
    if (!this.shouldAcceptMessage(message, botIdentity)) return
    if (this.isDuplicateMessage(message.messageId)) return

    const threadKey = this.buildThreadKey(message)
    const conversation = this.state.conversations[threadKey]
    const pendingHelpTask = conversation
      ? this.findAwaitingHelpTask(conversation.lastTaskId)
      : undefined

    if (pendingHelpTask) {
      await this.dispatchHelpResponseFromMessage(message, pendingHelpTask, threadKey)
      return
    }

    await this.dispatchUserMessageTask(message, threadKey, conversation?.lastTaskId)
  }

  private async handleCardAction(event: CardActionEvent): Promise<void> {
    const rawValue = event.action.value
    if (!rawValue || typeof rawValue !== 'object') return

    const value = rawValue as Record<string, unknown>
    if (value.kind !== 'help_reply') return

    const taskId = typeof value.taskId === 'string' ? value.taskId : ''
    const responseText = typeof value.response === 'string' ? value.response.trim() : ''
    if (!taskId || !responseText) return

    const task = this.state.tasks[taskId]
    if (!task) return

    if (task.status !== 'help_needed') {
      if (task.helpCardMessageId) {
        await this.channel.updateCard(task.helpCardMessageId, this.buildHelpCard(task, {
          submittedResponse: responseText,
          submissionState: 'stale',
        })).catch(() => {})
      }
      return
    }

    await this.dispatchHelpResponseFromCard(task, event, responseText)
  }

  private shouldAcceptMessage(message: NormalizedMessage, botIdentity?: BotIdentity): boolean {
    if (message.chatType === 'p2p') return true
    if (!message.mentionedBot) return false
    if (message.mentionAll) return false
    if (!botIdentity) return true
    return message.mentions.some((mention) => mention.openId === botIdentity.openId && mention.isBot)
  }

  private isDuplicateMessage(messageId: string): boolean {
    const seenAt = this.state.dedupMessageIds[messageId]
    if (seenAt) return true
    this.state.dedupMessageIds[messageId] = new Date().toISOString()
    const entries = Object.entries(this.state.dedupMessageIds).sort((a, b) => a[1].localeCompare(b[1]))
    while (entries.length > 1000) {
      const oldest = entries.shift()
      if (!oldest) break
      delete this.state.dedupMessageIds[oldest[0]]
    }
    return false
  }

  private buildThreadKey(message: NormalizedMessage): string {
    if (message.chatType === 'p2p') {
      return `p2p:${message.senderId}`
    }
    return `group:${message.chatId}`
  }

  private shouldReplyInThread(message: NormalizedMessage): boolean {
    return message.chatType === 'group' && Boolean(message.threadId)
  }

  private buildTaskTitle(message: NormalizedMessage): string {
    const sender = message.senderName || message.senderId
    return message.chatType === 'p2p'
      ? `Feishu DM from ${sender}`
      : `Feishu group mention from ${sender}`
  }

  private createTaskState(
    input: {
      chatId: string
      chatType: BridgeTaskState['chatType']
      replyInThread?: boolean
      senderId: string
      senderName?: string
      userMessageId: string
      userMessageText: string
      parentTaskId?: string
    },
    threadKey: string,
    taskId: string,
    title: string,
  ): BridgeTaskState {
    const now = new Date().toISOString()
    return {
      taskId,
      threadKey,
      chatId: input.chatId,
      chatType: input.chatType,
      replyInThread: input.replyInThread,
      senderId: input.senderId,
      senderName: input.senderName,
      userMessageId: input.userMessageId,
      userMessageText: input.userMessageText,
      targetAgentEmail: this.config.targetAgentEmail,
      status: 'dispatching',
      title,
      outputText: '',
      parentTaskId: input.parentTaskId,
      createdAt: now,
      updatedAt: now,
    }
  }

  private async dispatchUserMessageTask(
    message: NormalizedMessage,
    threadKey: string,
    parentTaskId?: string,
  ): Promise<void> {
    const title = this.buildTaskTitle(message)
    const attachmentBundle = await this.prepareAttachments(message)
    const repliedMessage = await this.resolveRepliedMessageContext(message)
    const repliedAttachmentBundle = repliedMessage
      ? await this.prepareAttachments(repliedMessage, {
          filenamePrefix: 'replied-',
          notesPrefix: 'Replied message ',
        })
      : { attachments: [], notes: [] }
    const bodyText = this.buildDispatchBody(
      message,
      attachmentBundle.notes,
      repliedMessage,
      repliedAttachmentBundle.notes,
    )
    const dispatchContext = this.buildDispatchContext(message)

    const task = this.createTaskState({
      chatId: message.chatId,
      chatType: message.chatType,
      replyInThread: this.shouldReplyInThread(message),
      senderId: message.senderId,
      senderName: message.senderName,
      userMessageId: message.messageId,
      userMessageText: message.content,
      parentTaskId,
    }, threadKey, randomUUID(), title)

    await this.dispatchTask(task, {
      bodyText,
      dispatchContext,
      attachments: [
        ...attachmentBundle.attachments,
        ...repliedAttachmentBundle.attachments,
      ],
      parentTaskId,
      reactOnReceive: true,
    })
  }

  private async dispatchHelpResponseFromMessage(
    message: NormalizedMessage,
    helpTask: BridgeTaskState,
    threadKey: string,
  ): Promise<void> {
    const responseText = message.content
    if (helpTask.helpCardMessageId) {
      await this.channel.updateCard(helpTask.helpCardMessageId, this.buildHelpCard(helpTask, {
        submittedResponse: responseText,
        submissionState: 'submitted',
      })).catch(() => {})
    }

    const title = `Feishu help reply from ${message.senderName || message.senderId}`
    const attachmentBundle = await this.prepareAttachments(message)
    const bodyText = this.buildHelpResponseBody(helpTask, responseText, attachmentBundle.notes)
    const dispatchContext = {
      ...this.buildDispatchContext(message),
      source_kind: 'help_reply',
      reply_to_task_id: helpTask.taskId,
    }

    const task = this.createTaskState({
      chatId: message.chatId,
      chatType: message.chatType,
      replyInThread: this.shouldReplyInThread(message),
      senderId: message.senderId,
      senderName: message.senderName,
      userMessageId: message.messageId,
      userMessageText: responseText,
      parentTaskId: helpTask.taskId,
    }, threadKey, randomUUID(), title)

    try {
      await this.dispatchTask(task, {
        bodyText,
        dispatchContext,
        attachments: attachmentBundle.attachments,
        parentTaskId: helpTask.taskId,
        reactOnReceive: true,
      })
    } catch (error) {
      if (helpTask.helpCardMessageId) {
        await this.channel.updateCard(helpTask.helpCardMessageId, this.buildHelpCard(helpTask, {
          submittedResponse: responseText,
          submissionState: 'failed',
        })).catch(() => {})
      }
      throw error
    }
  }

  private async dispatchHelpResponseFromCard(
    helpTask: BridgeTaskState,
    event: CardActionEvent,
    responseText: string,
  ): Promise<void> {
    const task = this.createTaskState({
      chatId: helpTask.chatId,
      chatType: helpTask.chatType,
      replyInThread: helpTask.replyInThread,
      senderId: event.operator.openId,
      senderName: event.operator.name || helpTask.senderName,
      userMessageId: `card-action:${event.messageId}:${randomUUID()}`,
      userMessageText: responseText,
      parentTaskId: helpTask.taskId,
    }, helpTask.threadKey, randomUUID(), `Feishu help reply from ${event.operator.name || event.operator.openId}`)

    if (helpTask.helpCardMessageId) {
      await this.channel.updateCard(helpTask.helpCardMessageId, this.buildHelpCard(helpTask, {
        submittedResponse: responseText,
        submissionState: 'submitted',
      })).catch(() => {})
    }

    try {
      await this.dispatchTask(task, {
        bodyText: this.buildHelpResponseBody(helpTask, responseText),
        dispatchContext: {
          source: 'feishu',
          source_kind: 'help_reply',
          chat_id: helpTask.chatId,
          chat_type: helpTask.chatType,
          sender_open_id: event.operator.openId,
          sender_name: event.operator.name || '',
          bot_open_id: this.channel.botIdentity?.openId || '',
          is_group_mention: String(helpTask.chatType === 'group'),
          feishu_message_id: event.messageId,
          reply_to_task_id: helpTask.taskId,
          reply_via: 'card_action',
        },
        parentTaskId: helpTask.taskId,
        reactOnReceive: false,
      })
    } catch (error) {
      if (helpTask.helpCardMessageId) {
        await this.channel.updateCard(helpTask.helpCardMessageId, this.buildHelpCard(helpTask, {
          submittedResponse: responseText,
          submissionState: 'failed',
        })).catch(() => {})
      }
      throw error
    }
  }

  private async dispatchTask(
    task: BridgeTaskState,
    options: {
      bodyText: string
      dispatchContext: Record<string, string>
      attachments?: AampAttachment[]
      parentTaskId?: string
      reactOnReceive?: boolean
    },
  ): Promise<void> {
    this.liveTaskIds.add(task.taskId)
    this.state.tasks[task.taskId] = task
    this.state.conversations[task.threadKey] = this.buildConversationState(task)
    await this.persistState()
    if (options.reactOnReceive !== false) {
      await this.addReceivedReaction(task)
    }

    const dispatchResult = await this.aamp.sendTask({
      to: this.config.targetAgentEmail,
      taskId: task.taskId,
      sessionKey: task.threadKey,
      title: task.title,
      bodyText: options.bodyText,
      dispatchContext: options.dispatchContext,
      parentTaskId: options.parentTaskId,
      attachments: options.attachments,
    }).catch(async (error: Error) => {
      task.status = 'failed'
      task.statusLabel = 'Dispatch failed'
      task.resultError = error.message
      task.updatedAt = new Date().toISOString()
      await this.sendOrUpdateTerminalCard(task)
      throw error
    })

    task.dispatchMessageId = dispatchResult.messageId
    task.status = 'pending'
    task.statusLabel = 'Awaiting agent response'
    task.updatedAt = new Date().toISOString()
    this.state.conversations[task.threadKey].lastTaskId = task.taskId
    this.state.conversations[task.threadKey].updatedAt = task.updatedAt
    await this.persistState()
  }

  private findAwaitingHelpTask(taskId?: string): BridgeTaskState | undefined {
    if (!taskId) return undefined
    const task = this.state.tasks[taskId]
    if (!task || task.status !== 'help_needed') return undefined
    return task
  }

  private buildConversationState(task: BridgeTaskState): BridgeConversationState {
    return {
      threadKey: task.threadKey,
      chatId: task.chatId,
      chatType: task.chatType,
      senderId: task.senderId,
      senderName: task.senderName,
      lastTaskId: task.taskId,
      lastBridgeMessageId: task.bridgeMessageId,
      updatedAt: task.updatedAt,
    }
  }

  private buildDispatchBody(
    message: NormalizedMessage,
    notes: string[] = [],
    repliedMessage?: RepliedMessageContext,
    repliedNotes: string[] = [],
  ): string {
    const resourceLines = message.resources.map((resource) => `- ${resource.type}: ${resource.fileName || resource.fileKey}`)
    const repliedResourceLines = repliedMessage?.resources.map((resource) => `- ${resource.type}: ${resource.fileName || resource.fileKey}`) ?? []
    const repliedCreatedAt = repliedMessage?.createTime
      ? new Date(repliedMessage.createTime).toISOString()
      : undefined
    return [
      `Feishu ${message.chatType === 'p2p' ? 'direct message' : 'group mention'}:`,
      '',
      message.content.trim() || '(empty message)',
      ...(repliedMessage
        ? [
            '',
            'Replied Feishu message:',
            `- Message ID: ${repliedMessage.messageId}`,
            ...(repliedMessage.senderId ? [`- Sender: ${repliedMessage.senderId}`] : []),
            `- Type: ${repliedMessage.rawContentType || 'unknown'}`,
            ...(repliedCreatedAt ? [`- Created at: ${repliedCreatedAt}`] : []),
            '',
            'Replied message content:',
            repliedMessage.content.trim() || '(empty message)',
            ...(repliedResourceLines.length ? ['', 'Replied message attached resources:', ...repliedResourceLines] : []),
            ...(repliedMessage.notes.length || repliedNotes.length
              ? ['', 'Replied message notes:', ...repliedMessage.notes, ...repliedNotes]
              : []),
          ]
        : []),
      ...(resourceLines.length ? ['', 'Attached resources:', ...resourceLines] : []),
      ...(notes.length ? ['', 'Attachment notes:', ...notes] : []),
    ].join('\n')
  }

  private buildHelpResponseBody(helpTask: BridgeTaskState, responseText: string, notes: string[] = []): string {
    return [
      'Feishu response to help request:',
      '',
      `Original task: ${helpTask.taskId}`,
      ...(helpTask.helpQuestion ? [`Question: ${helpTask.helpQuestion}`] : []),
      ...(helpTask.blockedReason ? [`Blocked reason: ${helpTask.blockedReason}`] : []),
      '',
      'User response:',
      responseText.trim() || '(empty response)',
      ...(notes.length ? ['', 'Attachment notes:', ...notes] : []),
    ].join('\n')
  }

  private buildDispatchContext(message: NormalizedMessage): Record<string, string> {
    const raw = (message.raw ?? {}) as SenderRawEvent
    return {
      source: 'feishu',
      chat_id: message.chatId,
      chat_type: message.chatType,
      sender_open_id: message.senderId,
      sender_name: message.senderName || '',
      bot_open_id: this.channel.botIdentity?.openId || '',
      is_group_mention: String(message.chatType === 'group'),
      feishu_message_id: message.messageId,
      feishu_reply_to_message_id: message.replyToMessageId || '',
      feishu_root_id: message.rootId || '',
      feishu_thread_id: message.threadId || '',
      tenant_key: raw.sender?.tenant_key || '',
    }
  }

  private buildSenderPolicyHint(task: BridgeTaskState): string[] | null {
    const errorText = task.resultError?.toLowerCase() ?? ''
    if (!errorText.includes('senderpolicies')) return null

    const senderOpenId = task.senderId.trim()
    const policySnippet = [
      '[',
      '  {"sender":"<bridge_mailbox_email>","dispatchContextRules":{"sender_open_id":["OPEN_ID_HERE"]}}',
      ']',
    ].join('\n')

    return [
      '这个目标 Agent 拒绝了当前 bridge 发件人。请在 target agent 上配置 `senderPolicies`，并放行当前 bridge 邮箱与 `X-AAMP-Dispatch-Context.sender_open_id`。',
      '',
      `Dispatch-Context.sender_open_id: ${senderOpenId}`,
      'sender 参数请使用本地 `aamp-feishu-bridge status` 里显示的 AAMP mailbox。',
      '',
      '建议配置：',
      '```json',
      policySnippet.replace('OPEN_ID_HERE', senderOpenId),
      '```',
    ]
  }

  private buildReplyTarget(task: BridgeTaskState): DispatchReplyTarget {
    return {
      chatId: task.chatId,
      replyTo: task.userMessageId,
      replyInThread: task.replyInThread === true,
    }
  }

  private buildCardShell(
    elements: Record<string, unknown>[],
    options: { streaming?: boolean } = {},
  ): Record<string, unknown> {
    return {
      schema: '2.0',
      config: {
        wide_screen_mode: true,
        ...(options.streaming
          ? {
            streaming_mode: true,
            summary: { content: '' },
            streaming_config: {
              print_frequency_ms: CARD_STREAM_PRINT_FREQUENCY_MS,
              print_step: CARD_STREAM_PRINT_STEP,
              print_strategy: 'fast',
            },
          }
          : {}),
      },
      body: {
        direction: 'vertical',
        vertical_spacing: '12px',
        elements,
      },
    }
  }

  private buildStreamingCard(task: BridgeTaskState): Record<string, unknown> {
    const statusText = this.buildStreamingStatusText(task)
    const elements = this.buildStreamTimelineElements(task, { includePlaceholder: true })

    if (statusText) {
      elements.push({
        tag: 'markdown',
        element_id: 'st_s',
        content: this.sanitizeCardText(`_${statusText}_`),
      })
    }

    return this.buildCardShell(elements, { streaming: true })
  }

  private buildHelpPreludeCard(task: BridgeTaskState): Record<string, unknown> {
    const elements: Record<string, unknown>[] = [
      {
        tag: 'markdown',
        content: this.sanitizeCardText([
          '我还需要一些信息才能继续。',
          ...(task.helpQuestion ? ['', task.helpQuestion] : []),
          ...(task.blockedReason ? ['', `原因：${task.blockedReason}`] : []),
        ].join('\n')),
      },
    ]

    elements.push(...this.buildStreamTimelineElements(task, {
      textPanelTitle: '刚才的过程',
      includePlaceholder: false,
    }))

    return this.buildCardShell(elements)
  }

  private buildTerminalCard(
    task: BridgeTaskState,
    options: { includeReplay?: boolean } = {},
  ): Record<string, unknown> {
    if (task.status === 'completed') {
      return this.buildResultCard(task, options)
    }
    return this.buildErrorCard(task, options)
  }

  private buildResultCard(
    task: BridgeTaskState,
    options: { includeReplay?: boolean } = {},
  ): Record<string, unknown> {
    const finalText = this.renderCompletedMarkdown(task)
    const streamText = task.streamText?.trim()
    const elements: Record<string, unknown>[] = []
    if (options.includeReplay !== false && (
      (streamText && this.shouldShowReplayPanel(streamText, finalText))
      || task.streamEntries?.some((entry) => entry.type === 'tool')
    )) {
      elements.push(...this.buildStreamTimelineElements(task, {
        textPanelTitle: '过程回放',
        includePlaceholder: false,
      }))
    }
    elements.push({
      tag: 'markdown',
      content: finalText,
    })
    return this.buildCardShell(elements)
  }

  private buildErrorCard(
    task: BridgeTaskState,
    options: { includeReplay?: boolean } = {},
  ): Record<string, unknown> {
    const lines = [
      task.outputText.trim() || '这次回复没有成功完成。',
      ...(task.resultError ? ['', `错误信息：${task.resultError}`] : []),
    ]
    const senderPolicyHint = this.buildSenderPolicyHint(task)
    if (senderPolicyHint) {
      lines.push('', ...senderPolicyHint)
    }

    const streamText = task.streamText?.trim()
    const elements: Record<string, unknown>[] = []
    if (options.includeReplay !== false && (
      (streamText && this.shouldShowReplayPanel(streamText, lines.join('\n')))
      || task.streamEntries?.some((entry) => entry.type === 'tool')
    )) {
      elements.push(...this.buildStreamTimelineElements(task, {
        textPanelTitle: '过程回放',
        includePlaceholder: false,
      }))
    }
    elements.push({
      tag: 'markdown',
      content: this.sanitizeCardText(lines.join('\n')),
    })
    return this.buildCardShell(elements)
  }

  private buildLightToolPanel(
    entry: Extract<BridgeStreamEntry, { type: 'tool' }>,
    options: { elementId: string; contentElementId: string },
  ): Record<string, unknown> {
    const toolCount = Math.max(
      1,
      entry.tools?.length
        ?? entry.content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length,
    )
    const title = `执行了 ${toolCount} 个工具调用`

    return {
      tag: 'collapsible_panel',
      expanded: false,
      element_id: options.elementId,
      header: {
        title: {
          tag: 'markdown',
          content: this.sanitizeCardText(`<font color='grey'>${title}</font>`),
        },
        vertical_align: 'center',
        padding: '0px 0px 0px 0px',
        icon: {
          tag: 'standard_icon',
          token: 'right-small-ccm_outlined',
          color: 'grey',
          size: '16px 16px',
        },
        icon_position: 'follow_text',
        icon_expanded_angle: 90,
      },
      elements: [
        {
          tag: 'markdown',
          element_id: options.contentElementId,
          content: this.sanitizeCardText(entry.content.trim()),
        },
      ],
    }
  }

  private buildLightTimelinePanel(
    title: string,
    elements: Record<string, unknown>[],
    options: { elementId: string },
  ): Record<string, unknown> {
    return {
      tag: 'collapsible_panel',
      expanded: false,
      element_id: options.elementId,
      header: {
        title: {
          tag: 'markdown',
          content: this.sanitizeCardText(`<font color='grey'>${title}</font>`),
        },
        vertical_align: 'center',
        padding: '0px 0px 0px 0px',
        icon: {
          tag: 'standard_icon',
          token: 'right-small-ccm_outlined',
          color: 'grey',
          size: '16px 16px',
        },
        icon_position: 'follow_text',
        icon_expanded_angle: 90,
      },
      elements,
    }
  }

  private buildStreamTimelineElements(
    task: BridgeTaskState,
    options: {
      includePlaceholder?: boolean
      textPanelTitle?: string
    } = {},
  ): Record<string, unknown>[] {
    const entries = this.resolveStreamEntries(task)
    const elements: Record<string, unknown>[] = []

    if (entries.length === 0) {
      if (options.includePlaceholder === false) return elements
      return [{
        tag: 'markdown',
        element_id: 'st_ph',
        content: this.sanitizeCardText('_正在思考..._'),
      }]
    }

    entries.forEach((entry, index) => {
      const elementId = this.buildStreamEntryElementId(entry.type, index)
      if (entry.type === 'text') {
        const text = entry.text.trim()
        if (!text) return

        elements.push({
          tag: 'markdown',
          element_id: elementId,
          content: this.sanitizeCardText(text),
        })
        return
      }

      elements.push(this.buildLightToolPanel(entry, {
        elementId,
        contentElementId: this.buildStreamEntryContentElementId('tool', index),
      }))
    })

    if (options.textPanelTitle && elements.length > 0) {
      return [this.buildLightTimelinePanel(options.textPanelTitle, elements, {
        elementId: 'st_rp',
      })]
    }

    return elements
  }

  private renderCompletedMarkdown(task: BridgeTaskState): string {
    return this.sanitizeCardText(task.outputText.trim() || task.streamText?.trim() || '已经处理完成。')
  }

  private buildStreamingStatusText(task: BridgeTaskState): string {
    if (task.progressLabel?.trim()) return task.progressLabel.trim()
    if (task.statusLabel?.trim()) return task.statusLabel.trim()
    return '正在回复...'
  }

  private sanitizeStreamEntryId(value: string): string {
    return value
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 48) || randomUUID().slice(0, 8)
  }

  private toCardElementId(value: string): string {
    const normalized = value
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[^a-zA-Z]+/, '')
      .slice(0, 20)
    return normalized || `e${Math.abs(this.hashString(value)).toString(36).slice(0, 8)}`
  }

  private buildStreamEntryElementId(type: BridgeStreamEntry['type'], index: number): string {
    return this.toCardElementId(`st_${type === 'text' ? 't' : 'o'}_${index}`)
  }

  private buildStreamEntryContentElementId(type: BridgeStreamEntry['type'], index: number): string {
    return this.toCardElementId(`st_${type === 'text' ? 'tc' : 'oc'}_${index}`)
  }

  private resolveStreamEntries(task: BridgeTaskState): BridgeStreamEntry[] {
    const entries = task.streamEntries?.length ? task.streamEntries : this.resolveLegacyStreamEntries(task)
    return this.sliceStreamEntries(entries, task.streamCardStart)
  }

  private resolveLegacyStreamEntries(task: BridgeTaskState): BridgeStreamEntry[] {
    const entries: BridgeStreamEntry[] = []
    if (task.streamText?.trim()) {
      entries.push({
        id: 'legacy_text',
        type: 'text',
        text: task.streamText,
      })
    }
    if (task.toolTraceText?.trim()) {
      entries.push({
        id: 'legacy_tools',
        type: 'tool',
        title: this.buildToolPanelTitle({ label: '工具调用' }),
        content: task.toolTraceText,
      })
    }
    return entries
  }

  private sliceStreamEntries(
    entries: BridgeStreamEntry[],
    cursor: BridgeStreamCursor | undefined,
  ): BridgeStreamEntry[] {
    if (!cursor) return entries

    const entryIndex = Math.max(0, Math.min(cursor.entryIndex, entries.length))
    return entries.slice(entryIndex).flatMap((entry, index) => {
      if (index !== 0 || entry.type !== 'text' || cursor.textOffset == null) return [entry]

      const text = entry.text.slice(Math.max(0, cursor.textOffset))
      if (!text.trim()) return []
      return [{
        ...entry,
        text,
      }]
    })
  }

  private captureStreamCursorForAppend(task: BridgeTaskState, kind: 'text' | 'tool' | 'status'): BridgeStreamCursor {
    const entries = task.streamEntries ?? []
    const last = entries.at(-1)
    if (!last) return { entryIndex: 0 }

    if (kind === 'text') {
      if (last.type === 'text') {
        return {
          entryIndex: entries.length - 1,
          textOffset: last.text.length,
        }
      }
      return { entryIndex: entries.length }
    }

    if (kind === 'tool' && last.type === 'tool') {
      return { entryIndex: entries.length - 1 }
    }

    return { entryIndex: entries.length }
  }

  private appendTextDelta(task: BridgeTaskState, text: string): void {
    if (!text) return
    task.streamText = (task.streamText ?? '') + text

    const entries = task.streamEntries ?? []
    const last = entries.at(-1)
    if (last?.type === 'text') {
      last.text += text
    } else {
      entries.push({
        id: `text_${entries.length}`,
        type: 'text',
        text,
      })
    }
    task.streamEntries = entries
  }

  private isToolProgressPayload(payload: Record<string, unknown>): boolean {
    return Boolean(
      payload.toolCallId
      || payload.title
      || payload.kind
      || payload.status
    )
  }

  private isGenericToolName(value: string): boolean {
    const normalized = value.trim().toLowerCase()
    return !normalized || normalized === 'tool' || normalized === '工具' || this.isOpaqueToolCallId(normalized)
  }

  private isOpaqueToolCallId(value: string): boolean {
    return /^call_[a-z0-9]+$/i.test(value.trim())
  }

  private compactToolName(value: string): string {
    const raw = value
      .replace(/^Tool\s+(?:running|completed|failed|pending):\s*/i, '')
      .split(/\r?\n/)[0]
      ?.trim() ?? ''
    const withoutOutput = raw.replace(/\s+>\s+\S.*$/, '').trim()
    const withoutFlags = withoutOutput.replace(/\s--[a-zA-Z0-9-]+(?:[=\s].*)?$/, '').trim()
    const compact = withoutFlags || withoutOutput || raw || '工具'
    return compact.length > 48 ? `${compact.slice(0, 47)}...` : compact
  }

  private readToolName(payload: Record<string, unknown>): string {
    const label = typeof payload.label === 'string' ? payload.label.trim() : ''
    const labelMatch = /^Tool\s+(?:running|completed|failed|pending):\s*(.+)$/i.exec(label)
    const candidates = [
      typeof payload.title === 'string' ? payload.title.trim() : '',
      labelMatch?.[1]?.trim() ?? '',
      label,
      typeof payload.kind === 'string' ? payload.kind.trim() : '',
    ].map((candidate) => this.compactToolName(candidate)).filter(Boolean)

    return candidates.find((candidate) => !this.isGenericToolName(candidate)) ?? candidates[0] ?? '工具'
  }

  private readToolStatus(payload: Record<string, unknown>): string | undefined {
    const explicit = typeof payload.status === 'string' ? payload.status.trim() : ''
    if (explicit) return explicit

    const label = typeof payload.label === 'string' ? payload.label.trim() : ''
    const match = /^Tool\s+(running|completed|failed|pending):/i.exec(label)
    const byLabel: Record<string, string> = {
      running: 'in_progress',
      completed: 'completed',
      failed: 'failed',
      pending: 'pending',
    }
    return match?.[1] ? byLabel[match[1].toLowerCase()] : undefined
  }

  private formatToolStatus(status?: string): string {
    const statusLabelByValue: Record<string, string> = {
      pending: '等待',
      running: '执行中',
      in_progress: '执行中',
      completed: '完成',
      failed: '失败',
    }
    return status ? (statusLabelByValue[status] ?? status) : '执行中'
  }

  private buildToolGroupTitle(tools: BridgeToolTraceItem[]): string {
    const names = Array.from(new Set(tools.map((tool) => tool.name).filter(Boolean)))
    if (names.length === 0) return '工具调用'
    if (names.length === 1) return `工具调用 · ${names[0]}`
    const visible = names.slice(0, 3).join('、')
    return names.length > 3 ? `工具调用 · ${visible} 等 ${names.length} 个` : `工具调用 · ${visible}`
  }

  private formatToolGroupContent(tools: BridgeToolTraceItem[]): string {
    return tools
      .map((tool) => {
        const lines = [`- ${tool.name} · ${this.formatToolStatus(tool.status)}`]
        if (tool.input) lines.push(...this.formatToolDetailLines('输入', tool.input))
        if (tool.output) lines.push(...this.formatToolDetailLines('输出', tool.output))
        return lines.join('\n')
      })
      .join('\n')
  }

  private formatToolDetailLines(label: string, value: string): string[] {
    const lines = value.trim().split(/\r?\n/)
    if (lines.length === 0 || !lines[0]) return []
    if (lines.length === 1) return [`  - ${label}: ${lines[0]}`]
    return [
      `  - ${label}:`,
      ...lines.map((line) => `    ${line}`),
    ]
  }

  private buildToolPanelTitle(payload: Record<string, unknown>): string {
    return `工具调用 · ${this.readToolName(payload)}`
  }

  private resolveToolKey(
    tools: BridgeToolTraceItem[],
    toolCallId: string | undefined,
    toolName: string,
    status: string | undefined,
  ): string {
    if (toolCallId) return `id:${toolCallId}`

    if (this.isGenericToolName(toolName) && status && status !== 'in_progress' && status !== 'pending') {
      const running = [...tools].reverse().find((tool) => tool.status !== 'completed' && tool.status !== 'failed')
      if (running) return running.key
    }

    return `name:${toolName}`
  }

  private findToolEntryForUpdate(
    entries: BridgeStreamEntry[],
    toolCallId: string | undefined,
    toolName: string,
    status: string | undefined,
  ): Extract<BridgeStreamEntry, { type: 'tool' }> | undefined {
    const last = entries.at(-1)
    if (last?.type === 'tool') return last

    if (toolCallId) {
      const key = `id:${toolCallId}`
      const match = [...entries].reverse().find((entry) => (
        entry.type === 'tool'
        && (entry.toolCallId === toolCallId || entry.tools?.some((tool) => tool.key === key))
      ))
      if (match?.type === 'tool') return match
    }

    const isFinishing = status === 'completed' || status === 'failed'
    if (!isFinishing) return undefined

    if (this.isGenericToolName(toolName)) {
      return [...entries].reverse().find((entry) => (
        entry.type === 'tool'
        && entry.tools?.some((tool) => tool.status !== 'completed' && tool.status !== 'failed')
      )) as Extract<BridgeStreamEntry, { type: 'tool' }> | undefined
    }

    return [...entries].reverse().find((entry) => (
      entry.type === 'tool'
      && entry.tools?.some((tool) => (
        tool.name === toolName
        && tool.status !== 'completed'
        && tool.status !== 'failed'
      ))
    )) as Extract<BridgeStreamEntry, { type: 'tool' }> | undefined
  }

  private appendToolProgress(task: BridgeTaskState, payload: Record<string, unknown>): void {
    const entries = task.streamEntries ?? []
    const toolCallId = typeof payload.toolCallId === 'string' && payload.toolCallId.trim()
      ? payload.toolCallId.trim()
      : undefined
    const incomingName = this.readToolName(payload)
    const status = this.readToolStatus(payload) ?? 'in_progress'
    const input = this.readStreamPayloadString(payload, ['input'])
    const output = this.readStreamPayloadString(payload, ['output'])
    let entry = this.findToolEntryForUpdate(entries, toolCallId, incomingName, status)
    if (!entry) {
      entry = {
        id: this.sanitizeStreamEntryId(`tools_${entries.length}`),
        type: 'tool',
        title: '工具调用',
        content: '',
        tools: [],
      }
      entries.push(entry)
    }

    const tools = entry.tools ?? []
    const key = this.resolveToolKey(tools, toolCallId, incomingName, status)
    const existing = tools.find((tool) => tool.key === key)

    if (existing) {
      if (!this.isGenericToolName(incomingName)) existing.name = incomingName
      existing.status = status
      if (input) existing.input = input
      if (output) existing.output = output
    } else {
      const name = this.isGenericToolName(incomingName) && toolCallId ? '工具' : incomingName
      tools.push({
        key,
        name,
        status,
        ...(input ? { input } : {}),
        ...(output ? { output } : {}),
      })
    }

    entry.tools = tools
    entry.toolCallId = toolCallId ?? entry.toolCallId
    entry.title = this.buildToolGroupTitle(tools)
    entry.content = this.formatToolGroupContent(tools)
    task.toolTraceText = entry.content
    task.streamEntries = entries
  }

  private shouldShowReplayPanel(streamText?: string, finalText?: string): boolean {
    const streamNormalized = this.normalizeForReplayComparison(streamText)
    if (!streamNormalized) return false

    const finalNormalized = this.normalizeForReplayComparison(finalText)
    if (!finalNormalized) return true
    if (streamNormalized === finalNormalized) return false

    const longer = streamNormalized.length >= finalNormalized.length ? streamNormalized : finalNormalized
    const shorter = longer === streamNormalized ? finalNormalized : streamNormalized
    const lengthGap = longer.length - shorter.length

    if (lengthGap <= 24 && longer.includes(shorter)) {
      return false
    }

    return true
  }

  private normalizeForReplayComparison(value?: string): string {
    return (value ?? '')
      .replace(/\s+/g, ' ')
      .replace(/[*_`>#-]/g, '')
      .trim()
  }

  private sanitizeCardText(value: string): string {
    return value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => {
      const [local = '', domain = ''] = email.split('@')
      const maskedLocal = local.length <= 2
        ? `${local[0] ?? '*'}*`
        : `${local.slice(0, 2)}***`
      const domainParts = domain.split('.').filter(Boolean)
      const primaryDomain = domainParts[0] ?? 'domain'
      const tld = domainParts.length > 1 ? domainParts[domainParts.length - 1] : ''
      const maskedDomain = primaryDomain.length <= 2
        ? `${primaryDomain[0] ?? '*'}*`
        : `${primaryDomain.slice(0, 2)}***`
      return tld ? `${maskedLocal} at ${maskedDomain} dot ${tld}` : `${maskedLocal} at ${maskedDomain}`
    })
  }

  private hashString(value: string): number {
    let hash = 0
    for (let index = 0; index < value.length; index += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(index)
      hash |= 0
    }
    return hash
  }

  private async resolveRepliedMessageContext(message: NormalizedMessage): Promise<RepliedMessageContext | undefined> {
    const replyToMessageId = message.replyToMessageId?.trim()
    if (!replyToMessageId || replyToMessageId === message.messageId) return undefined

    try {
      const response = await this.channel.rawClient.im.v1.message.get({
        path: {
          message_id: replyToMessageId,
        },
        params: {
          user_id_type: 'open_id',
          card_msg_content_type: 'user_card_content',
        },
      } as Parameters<typeof this.channel.rawClient.im.v1.message.get>[0] & {
        params: {
          user_id_type: 'open_id'
          card_msg_content_type: 'user_card_content'
        }
      })
      const responseRecord = response && typeof response === 'object' ? response as Record<string, unknown> : {}
      const code = typeof responseRecord.code === 'number' ? responseRecord.code : 0
      if (code !== 0) {
        throw new Error(`${responseRecord.msg ?? `code=${code}`}`)
      }

      const data = this.extractResponseData(response)
      const items = Array.isArray(data.items) ? data.items : []
      const item = items
        .map((value) => value && typeof value === 'object' ? value as Record<string, unknown> : undefined)
        .find((value) => value?.message_id === replyToMessageId)
        ?? (items[0] && typeof items[0] === 'object' ? items[0] as Record<string, unknown> : undefined)

      if (!item) {
        throw new Error('message.get returned no items')
      }

      const body = item.body && typeof item.body === 'object' ? item.body as Record<string, unknown> : {}
      const rawContent = typeof body.content === 'string' ? body.content : ''
      const rawContentType = typeof item.msg_type === 'string' ? item.msg_type : ''
      const mentions = Array.isArray(item.mentions) ? item.mentions : []
      const storedCardText = rawContentType === 'interactive'
        ? this.resolveStoredCardMessageText(replyToMessageId)
        : undefined
      const parsed = this.parseReferencedMessageContent(rawContent, rawContentType, mentions)
      const content = parsed.content === '[interactive card]' && storedCardText
        ? storedCardText
        : parsed.content
      const sender = item.sender && typeof item.sender === 'object' ? item.sender as Record<string, unknown> : {}
      const createTime = typeof item.create_time === 'string'
        ? Number.parseInt(item.create_time, 10)
        : undefined

      return {
        messageId: typeof item.message_id === 'string' ? item.message_id : replyToMessageId,
        senderId: typeof sender.id === 'string' ? sender.id : undefined,
        createTime: createTime != null && Number.isFinite(createTime) ? createTime : undefined,
        rawContentType,
        content,
        resources: parsed.resources,
        notes: content === storedCardText ? ['Resolved replied card content from local bridge state.'] : [],
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      this.logger.error(`[feishu reply context ${message.messageId}] Failed to fetch ${replyToMessageId}: ${reason}`)
      return {
        messageId: replyToMessageId,
        rawContentType: 'unknown',
        content: '',
        resources: [],
        notes: [`Failed to fetch replied message ${replyToMessageId}: ${reason}`],
      }
    }
  }

  private parseReferencedMessageContent(
    rawContent: string,
    rawContentType: string,
    rawMentions: unknown[],
  ): { content: string; resources: ResourceDescriptor[] } {
    const parsed = this.safeParseRecord(rawContent)
    const resources: ResourceDescriptor[] = []
    const type = rawContentType.toLowerCase()

    if (type === 'text') {
      const text = typeof parsed?.text === 'string' ? parsed.text : rawContent
      return {
        content: this.resolveReferencedMentions(text, rawMentions),
        resources,
      }
    }

    if (type === 'post') {
      return this.parseReferencedPostContent(parsed, rawMentions)
    }

    if (type === 'image') {
      const fileKey = typeof parsed?.image_key === 'string' ? parsed.image_key : ''
      if (fileKey) resources.push({ type: 'image', fileKey })
      return { content: fileKey ? `![image](${fileKey})` : '[image]', resources }
    }

    if (type === 'file') {
      const fileKey = typeof parsed?.file_key === 'string' ? parsed.file_key : ''
      const fileName = typeof parsed?.file_name === 'string' ? parsed.file_name : undefined
      if (fileKey) resources.push({ type: 'file', fileKey, fileName })
      return { content: fileKey ? `<file key="${fileKey}"${fileName ? ` name="${fileName}"` : ''}/>` : '[file]', resources }
    }

    if (type === 'audio') {
      const fileKey = typeof parsed?.file_key === 'string' ? parsed.file_key : ''
      const durationMs = typeof parsed?.duration === 'number' ? parsed.duration : undefined
      if (fileKey) resources.push({ type: 'audio', fileKey, durationMs })
      return { content: fileKey ? `<audio key="${fileKey}"/>` : '[audio]', resources }
    }

    if (type === 'media' || type === 'video') {
      const fileKey = typeof parsed?.file_key === 'string' ? parsed.file_key : ''
      const coverImageKey = typeof parsed?.image_key === 'string' ? parsed.image_key : undefined
      if (fileKey) resources.push({ type: 'video', fileKey, coverImageKey })
      return { content: fileKey ? `<video key="${fileKey}"/>` : '[video]', resources }
    }

    if (type === 'sticker') {
      const fileKey = typeof parsed?.file_key === 'string' ? parsed.file_key : ''
      if (fileKey) resources.push({ type: 'sticker', fileKey })
      return { content: fileKey ? `<sticker key="${fileKey}"/>` : '[sticker]', resources }
    }

    if (type === 'interactive') {
      return {
        content: this.extractInteractiveCardText(parsed ?? rawContent) || '[interactive card]',
        resources,
      }
    }

    const fallback = this.extractTextFromArbitraryJson(parsed ?? rawContent) || `[${rawContentType || 'message'}]`
    return {
      content: this.resolveReferencedMentions(fallback, rawMentions),
      resources,
    }
  }

  private resolveStoredCardMessageText(messageId: string): string | undefined {
    const matchingTask = Object.values(this.state.tasks).find((task) => (
      task.bridgeMessageId === messageId
      || task.helpCardMessageId === messageId
      || task.dispatchMessageId === messageId
    ))
    if (!matchingTask) return undefined

    const streamText = matchingTask.streamText?.trim()
    const outputText = matchingTask.outputText?.trim()
    const helpQuestion = matchingTask.helpQuestion?.trim()
    const resultError = matchingTask.resultError?.trim()
    const userMessage = matchingTask.userMessageText?.trim()

    if (outputText) return outputText
    if (streamText) return streamText
    if (helpQuestion) {
      return [
        'Agent requested more information:',
        helpQuestion,
        ...(matchingTask.blockedReason ? ['', `Blocked reason: ${matchingTask.blockedReason}`] : []),
      ].join('\n')
    }
    if (resultError) return `Agent card error: ${resultError}`
    if (userMessage) return userMessage
    return undefined
  }

  private extractInteractiveCardText(value: unknown): string {
    const rawText = this.extractTextFromArbitraryJson(value)
    const lines = rawText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !this.isInteractiveCardNoiseLine(line))

    return Array.from(new Set(lines)).slice(0, 30).join('\n')
  }

  private isInteractiveCardNoiseLine(line: string): boolean {
    if (/请升级至最新版本客户端|upgrade.*client/i.test(line)) return true
    if (/^---\s*This email was sent by AAMP\./i.test(line)) return true
    if (/^(img|text|button|markdown|plain_text|lark_md|column|column_set|div|note)$/i.test(line)) return true
    if (/^(img|om|oc|ou|cli|msg|card|evt|str|task|call)_[a-z0-9_-]{12,}$/i.test(line)) return true
    return false
  }

  private parseReferencedPostContent(
    parsed: Record<string, unknown> | undefined,
    rawMentions: unknown[],
  ): { content: string; resources: ResourceDescriptor[] } {
    if (!parsed) return { content: '[rich text message]', resources: [] }

    const localized = this.unwrapPostLocale(parsed)
    const resources: ResourceDescriptor[] = []
    const title = typeof localized?.title === 'string' ? localized.title.trim() : ''
    const rawBlocks = Array.isArray(localized?.content) ? localized.content : []
    const lines = rawBlocks.flatMap((block) => {
      if (!Array.isArray(block)) return []
      const line = block.map((element) => this.renderReferencedPostElement(element, rawMentions, resources)).join('').trimEnd()
      return line ? [line] : []
    })

    const content = [
      ...(title ? [title] : []),
      ...lines,
    ].join('\n').trim()

    return {
      content: content || '[rich text message]',
      resources,
    }
  }

  private renderReferencedPostElement(
    value: unknown,
    rawMentions: unknown[],
    resources: ResourceDescriptor[],
  ): string {
    if (!value || typeof value !== 'object') return ''
    const element = value as Record<string, unknown>
    const tag = typeof element.tag === 'string' ? element.tag : ''

    if (tag === 'text') return typeof element.text === 'string' ? element.text : ''
    if (tag === 'a') {
      const text = typeof element.text === 'string' ? element.text : ''
      const href = typeof element.href === 'string' ? element.href : ''
      return href ? `[${text || href}](${href})` : text
    }
    if (tag === 'at') {
      const userName = typeof element.user_name === 'string' ? element.user_name : ''
      const userId = typeof element.user_id === 'string' ? element.user_id : ''
      if (userId === 'all' || userId === 'all_members') return '@all'
      if (userName) return `@${userName}`
      const mentionName = this.findReferencedMentionName(rawMentions, userId)
      return mentionName ? `@${mentionName}` : (userId ? `@${userId}` : '@user')
    }
    if (tag === 'img') {
      const fileKey = typeof element.image_key === 'string' ? element.image_key : ''
      if (!fileKey) return ''
      resources.push({ type: 'image', fileKey })
      return `![image](${fileKey})`
    }
    if (tag === 'media') {
      const fileKey = typeof element.file_key === 'string' ? element.file_key : ''
      if (!fileKey) return ''
      resources.push({ type: 'file', fileKey })
      return `<file key="${fileKey}"/>`
    }
    if (tag === 'code_block') {
      const language = typeof element.language === 'string' ? element.language : ''
      const text = typeof element.text === 'string' ? element.text : ''
      return `\n\`\`\`${language}\n${text}\n\`\`\`\n`
    }
    if (tag === 'hr') return '\n---\n'
    return typeof element.text === 'string' ? element.text : ''
  }

  private safeParseRecord(value: string): Record<string, unknown> | undefined {
    try {
      const parsed = JSON.parse(value) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : undefined
    } catch {
      return undefined
    }
  }

  private unwrapPostLocale(parsed: Record<string, unknown>): Record<string, unknown> | undefined {
    if ('title' in parsed || 'content' in parsed) return parsed
    for (const key of ['zh_cn', 'en_us', 'ja_jp']) {
      const candidate = parsed[key]
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
        return candidate as Record<string, unknown>
      }
    }
    const first = Object.values(parsed).find((value) => value && typeof value === 'object' && !Array.isArray(value))
    return first as Record<string, unknown> | undefined
  }

  private resolveReferencedMentions(text: string, rawMentions: unknown[]): string {
    let current = text
    for (const item of rawMentions) {
      if (!item || typeof item !== 'object') continue
      const mention = item as Record<string, unknown>
      const key = typeof mention.key === 'string' ? mention.key : ''
      const name = typeof mention.name === 'string' ? mention.name : ''
      if (key && name) current = current.replaceAll(key, `@${name}`)
    }
    return current
  }

  private findReferencedMentionName(rawMentions: unknown[], userId: string): string | undefined {
    if (!userId) return undefined
    const match = rawMentions.find((item) => {
      if (!item || typeof item !== 'object') return false
      const mention = item as Record<string, unknown>
      return mention.id === userId
    }) as Record<string, unknown> | undefined
    return typeof match?.name === 'string' ? match.name : undefined
  }

  private extractTextFromArbitraryJson(value: unknown): string {
    const chunks: string[] = []
    const visit = (item: unknown) => {
      if (item == null) return
      if (typeof item === 'string') {
        if (item.trim()) chunks.push(item.trim())
        return
      }
      if (typeof item === 'number' || typeof item === 'boolean') return
      if (Array.isArray(item)) {
        item.forEach(visit)
        return
      }
      if (typeof item !== 'object') return

      const record = item as Record<string, unknown>
      for (const key of ['text', 'content', 'title', 'label', 'value']) {
        const candidate = record[key]
        if (typeof candidate === 'string' && candidate.trim()) {
          chunks.push(candidate.trim())
        }
      }
      Object.values(record).forEach(visit)
    }

    visit(value)
    return Array.from(new Set(chunks)).slice(0, 20).join('\n')
  }

  private async prepareAttachments(
    message: Pick<NormalizedMessage, 'messageId' | 'resources'>,
    options: { filenamePrefix?: string; notesPrefix?: string } = {},
  ): Promise<PreparedAttachments> {
    const attachments: AampAttachment[] = []
    const notes: string[] = []

    for (const resource of message.resources) {
      if (resource.type !== 'image' && resource.type !== 'file') {
        notes.push(`Skipped ${resource.type} resource ${resource.fileName || resource.fileKey}: unsupported by bridge uploader.`)
        continue
      }

      try {
        const downloaded = await this.downloadMessageResource(message.messageId, resource)
        const resolvedFilename = this.resolveAttachmentFilename(resource, downloaded.contentType)
        const filename = options.filenamePrefix ? `${options.filenamePrefix}${resolvedFilename}` : resolvedFilename
        attachments.push({
          filename,
          contentType: this.resolveAttachmentContentType(resource, filename, downloaded.contentType),
          content: downloaded.content,
          size: downloaded.content.byteLength,
        })
      } catch (error) {
        notes.push(`${options.notesPrefix ?? ''}Failed to download ${resource.type} resource ${resource.fileName || resource.fileKey}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return { attachments, notes }
  }

  private async downloadMessageResource(messageId: string, resource: ResourceDescriptor): Promise<DownloadedResource> {
    const type = resource.type === 'image' ? 'image' : 'file'
    try {
      const response = await this.channel.rawClient.im.v1.messageResource.get({
        path: {
          message_id: messageId,
          file_key: resource.fileKey,
        },
        params: { type },
      })
      return {
        content: await this.bufferFromReadableStream(response.getReadableStream()),
        contentType: this.contentTypeFromHeaders(response.headers),
      }
    } catch (primaryError) {
      try {
        return {
          content: await this.channel.downloadResource(resource.fileKey, type),
        }
      } catch (fallbackError) {
        const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError)
        const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
        throw new Error(`messageResource.get failed: ${primaryMessage}; fallback downloadResource failed: ${fallbackMessage}`)
      }
    }
  }

  private async bufferFromReadableStream(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    return Buffer.concat(chunks)
  }

  private contentTypeFromHeaders(headers: unknown): string | undefined {
    const value = typeof (headers as { get?: (name: string) => unknown } | undefined)?.get === 'function'
      ? (headers as { get(name: string): unknown }).get('content-type')
      : (headers as Record<string, unknown> | undefined)?.['content-type']
        ?? (headers as Record<string, unknown> | undefined)?.['Content-Type']
    return typeof value === 'string' && value.trim() ? value.split(';')[0]!.trim() : undefined
  }

  private extensionForContentType(contentType?: string): string | undefined {
    const normalized = contentType?.toLowerCase()
    const byContentType: Record<string, string> = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
    }
    return normalized ? byContentType[normalized] : undefined
  }

  private resolveAttachmentFilename(resource: ResourceDescriptor, contentType?: string): string {
    const fallbackBase = resource.type === 'image' ? 'feishu-image' : 'feishu-file'
    const baseName = resource.fileName?.trim() || `${fallbackBase}-${resource.fileKey.slice(0, 8)}`
    if (path.extname(baseName)) return baseName
    if (resource.type === 'image') return `${baseName}${this.extensionForContentType(contentType) ?? '.png'}`
    return baseName
  }

  private resolveAttachmentContentType(resource: ResourceDescriptor, filename: string, downloadedContentType?: string): string {
    if (downloadedContentType) return downloadedContentType
    const ext = path.extname(filename).toLowerCase()
    const byExtension: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.zip': 'application/zip',
    }
    if (byExtension[ext]) return byExtension[ext]
    return resource.type === 'image' ? 'image/png' : 'application/octet-stream'
  }

  private sanitizeAttachmentFilename(value: string | undefined, fallback: string): string {
    const normalized = value
      ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
      .trim()
    const lastSegment = (normalized || fallback).split(/[\\/]+/).filter(Boolean).pop() ?? fallback
    const filename = lastSegment
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return filename && filename !== '.' && filename !== '..' ? filename : fallback
  }

  private sanitizeResultAttachmentFilename(attachment: ReceivedAttachment, index: number): string {
    return this.sanitizeAttachmentFilename(attachment.filename, `attachment-${index + 1}`)
  }

  private describeResultAttachment(attachment: ReceivedAttachment, filename: string): string {
    const details = [
      filename,
      attachment.contentType,
      Number.isFinite(attachment.size) ? `${attachment.size} bytes` : '',
    ].filter(Boolean)
    return details.join(', ')
  }

  private isImageAttachment(attachment: ReceivedAttachment, filename: string): boolean {
    const contentType = attachment.contentType.toLowerCase()
    if (contentType.startsWith('image/')) return true
    return ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff']
      .includes(path.extname(filename).toLowerCase())
  }

  private describeError(error: unknown): string {
    if (!(error instanceof Error)) return String(error)

    const parts = [error.message]
    const details = error as Error & {
      code?: string | number
      cause?: unknown
      response?: {
        status?: number
        data?: {
          code?: number
          msg?: string
          message?: string
        }
      }
      data?: {
        code?: number
        msg?: string
        message?: string
      }
    }

    if (details.code != null) parts.push(`code=${details.code}`)
    const responseStatus = details.response?.status
    if (responseStatus != null) parts.push(`status=${responseStatus}`)
    const apiCode = details.response?.data?.code ?? details.data?.code
    if (apiCode != null) parts.push(`api_code=${apiCode}`)
    const apiMessage = details.response?.data?.msg ?? details.response?.data?.message ?? details.data?.msg ?? details.data?.message
    if (apiMessage) parts.push(apiMessage)

    if (details.cause) {
      parts.push(`cause=${this.describeError(details.cause)}`)
    }

    return parts.join(' | ')
  }

  private async sendResultAttachment(
    task: BridgeTaskState,
    attachment: ReceivedAttachment,
    filename: string,
    content: Buffer,
  ): Promise<string> {
    const options = {
      replyTo: task.bridgeMessageId || task.userMessageId,
      replyInThread: task.replyInThread === true,
    }

    if (this.isImageAttachment(attachment, filename)) {
      const result = await this.channel.send(
        task.chatId,
        { image: { source: content } },
        options,
      )
      return result.messageId
    }

    const result = await this.channel.send(
      task.chatId,
      {
        file: {
          source: content,
          fileName: filename,
        },
      },
      options,
    )
    return result.messageId
  }

  private async sendResultAttachments(
    task: BridgeTaskState,
    attachments: ReceivedAttachment[] | undefined,
  ): Promise<ResultAttachmentSendOutcome> {
    const sent: string[] = []
    const failed: string[] = []
    if (!attachments?.length) return { sent, failed }

    const usedNames = new Set<string>()
    for (const [index, attachment] of attachments.entries()) {
      const baseName = this.sanitizeResultAttachmentFilename(attachment, index)
      const filename = usedNames.has(baseName) ? `${index + 1}-${baseName}` : baseName
      usedNames.add(filename)

      try {
        const content = await this.aamp.downloadBlob(attachment.blobId, attachment.filename)
        await this.sendResultAttachment(task, attachment, filename, content)
        task.updatedAt = new Date().toISOString()
        sent.push(filename)
      } catch (error) {
        const reason = this.describeError(error)
        const description = this.describeResultAttachment(attachment, filename)
        failed.push(`${description}: ${reason}`)
        this.logger.error(`[aamp->feishu attachment ${task.taskId}] Failed to send ${filename}: ${reason}`)
      }
    }

    await this.persistState()
    return { sent, failed }
  }

  private normalizeCardEntityData(card: Record<string, unknown>): string {
    return JSON.stringify(card)
  }

  private buildCardEntityMessageContent(cardId: string): string {
    return JSON.stringify({
      type: 'card',
      data: {
        card_id: cardId,
      },
    })
  }

  private extractResponseData(response: unknown): Record<string, unknown> {
    const record = response && typeof response === 'object' ? response as Record<string, unknown> : {}
    const data = record.data
    if (data && typeof data === 'object') return data as Record<string, unknown>
    return record
  }

  private pickResponseString(response: unknown, keys: string[]): string | undefined {
    const visit = (value: unknown): string | undefined => {
      if (!value || typeof value !== 'object') return undefined

      if (Array.isArray(value)) {
        for (const item of value) {
          const found = visit(item)
          if (found) return found
        }
        return undefined
      }

      const record = value as Record<string, unknown>
      for (const key of keys) {
        const candidate = record[key]
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim()
      }

      for (const item of Object.values(record)) {
        const found = visit(item)
        if (found) return found
      }
      return undefined
    }

    return visit(response)
  }

  private async createCardEntity(card: Record<string, unknown>): Promise<string> {
    const response = await this.channel.rawClient.cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: this.normalizeCardEntityData(card),
      },
    })
    const cardId = this.pickResponseString(response, ['card_id', 'cardId'])
    if (!cardId) {
      this.logger.error(`[feishu card entity] card.create response missing card_id: ${JSON.stringify(response).slice(0, 1000)}`)
      throw new Error('cardkit.card.create returned no card_id')
    }
    return cardId
  }

  private async updateCardEntity(
    cardId: string,
    card: Record<string, unknown>,
    sequence: number,
  ): Promise<void> {
    await this.channel.rawClient.cardkit.v1.card.update({
      path: {
        card_id: cardId,
      },
      data: {
        card: {
          type: 'card_json',
          data: this.normalizeCardEntityData(card),
        },
        sequence,
      },
    })
  }

  private async updateCardElementContent(
    cardId: string,
    elementId: string,
    content: string,
    sequence: number,
  ): Promise<void> {
    await this.channel.rawClient.cardkit.v1.cardElement.content({
      path: {
        card_id: cardId,
        element_id: elementId,
      },
      data: {
        content,
        sequence,
        uuid: `feishu_bridge_${cardId}_${sequence}`,
      },
    })
  }

  private async finishCardEntityStreaming(cardId: string, sequence: number): Promise<void> {
    await this.channel.rawClient.cardkit.v1.card.settings({
      path: {
        card_id: cardId,
      },
      data: {
        settings: JSON.stringify({
          config: {
            streaming_mode: false,
          },
        }),
        sequence,
        uuid: `feishu_bridge_finish_${cardId}_${sequence}`,
      },
    }).catch(() => {})
  }

  private async sendCardEntity(
    task: BridgeTaskState,
    cardId: string,
    replyTarget: DispatchReplyTarget,
  ): Promise<string> {
    const content = this.buildCardEntityMessageContent(cardId)
    if (replyTarget.replyTo) {
      try {
        const response = await this.channel.rawClient.im.v1.message.reply({
          path: {
            message_id: replyTarget.replyTo,
          },
          data: {
            content,
            msg_type: 'interactive',
            reply_in_thread: replyTarget.replyInThread === true,
          },
        })
        const messageId = this.pickResponseString(response, ['message_id', 'messageId'])
        if (messageId) return messageId
      } catch (error) {
        this.logger.error(`[feishu card entity ${task.taskId}] reply failed, falling back to chat send: ${this.describeError(error)}`)
      }
    }

    const response = await this.channel.rawClient.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: replyTarget.chatId,
        msg_type: 'interactive',
        content,
      },
    })
    const messageId = this.pickResponseString(response, ['message_id', 'messageId'])
    if (!messageId) {
      throw new Error('card entity message send returned no message_id')
    }
    return messageId
  }

  private collectMarkdownElements(
    value: unknown,
    elements: MarkdownElementContent[] = [],
  ): MarkdownElementContent[] {
    if (!value || typeof value !== 'object') return elements

    if (Array.isArray(value)) {
      value.forEach((item) => this.collectMarkdownElements(item, elements))
      return elements
    }

    const record = value as Record<string, unknown>
    if (
      record.tag === 'markdown'
      && typeof record.element_id === 'string'
      && typeof record.content === 'string'
    ) {
      elements.push({
        elementId: record.element_id,
        content: record.content,
      })
    }

    Object.values(record).forEach((item) => this.collectMarkdownElements(item, elements))
    return elements
  }

  private cardStructureFingerprint(card: Record<string, unknown>): string {
    const stripMarkdownContent = (value: unknown): unknown => {
      if (!value || typeof value !== 'object') return value
      if (Array.isArray(value)) return value.map((item) => stripMarkdownContent(item))

      const record = value as Record<string, unknown>
      return Object.fromEntries(Object.entries(record).map(([key, item]) => {
        if (
          record.tag === 'markdown'
          && typeof record.element_id === 'string'
          && key === 'content'
        ) return [key, '<markdown-content>']
        return [key, stripMarkdownContent(item)]
      }))
    }

    return JSON.stringify(stripMarkdownContent(card))
  }

  private buildMarkdownElementUpdateOperations(
    currentCard: Record<string, unknown>,
    nextCard: Record<string, unknown>,
  ): MarkdownElementContent[] | null {
    if (this.cardStructureFingerprint(currentCard) !== this.cardStructureFingerprint(nextCard)) {
      return null
    }

    const currentById = new Map(this.collectMarkdownElements(currentCard).map((item) => [item.elementId, item.content]))
    const nextElements = this.collectMarkdownElements(nextCard)
    const operations = nextElements.filter((item) => currentById.get(item.elementId) !== item.content)
    return operations.length > 0 ? operations : []
  }

  private createCardSession(task: BridgeTaskState, replyTarget: DispatchReplyTarget): FeishuCardSession {
    const runtime = this
    let messageId: string | undefined
    let cardId: string | undefined
    let entityMode = true
    let elementStreamingMode = true
    let readyResolve!: () => void
    let finishResolve!: () => void
    let chain = Promise.resolve()
    let currentCard = this.buildStreamingCard(task)
    let sequence = 0
    let abandoned = false

    const ready = new Promise<void>((resolve) => {
      readyResolve = resolve
    })
    const finish = new Promise<void>((resolve) => {
      finishResolve = resolve
    })

    const enqueue = async (op: () => Promise<void>): Promise<void> => {
      chain = chain.then(op, op)
      await chain
    }

    const result = (async () => {
      try {
        cardId = await this.createCardEntity(currentCard)
        messageId = await this.sendCardEntity(task, cardId, replyTarget)
      } catch (error) {
        entityMode = false
        cardId = undefined
        this.logger.error(`[feishu stream ${task.taskId}] card entity unavailable, falling back to message patch: ${this.describeError(error)}`)
        const sent = await this.channel.send(
          replyTarget.chatId,
          { card: currentCard },
          {
            replyTo: replyTarget.replyTo,
            replyInThread: replyTarget.replyInThread === true,
          },
        )
        messageId = sent.messageId
      }
      readyResolve()
      await finish
    })()

    const session: FeishuCardSession = {
      closed: false,
      get messageId() {
        return messageId
      },
      get cardId() {
        return cardId
      },
      get currentCard() {
        return currentCard
      },
      set currentCard(value: Record<string, unknown>) {
        currentCard = value
      },
      ready,
      result,
      async update(nextCard: Record<string, unknown>) {
        await ready
        await enqueue(async () => {
          if (abandoned) return
          if (entityMode && cardId) {
            const operations = runtime.buildMarkdownElementUpdateOperations(currentCard, nextCard)
            if (operations === null || !elementStreamingMode) {
              sequence += 1
              await runtime.updateCardEntity(cardId, nextCard, sequence)
            } else {
              try {
                for (const operation of operations) {
                  sequence += 1
                  await runtime.updateCardElementContent(cardId, operation.elementId, operation.content, sequence)
                }
              } catch (error) {
                elementStreamingMode = false
                runtime.logger.error(`[feishu stream ${task.taskId}] card element streaming failed, falling back to card entity update: ${runtime.describeError(error)}`)
                sequence += 1
                await runtime.updateCardEntity(cardId, nextCard, sequence)
              }
            }
          } else {
            if (!messageId) throw new Error('card message is not ready')
            await runtime.channel.updateCard(messageId, nextCard)
          }
          currentCard = nextCard
        })
      },
      async close(finalCard?: Record<string, unknown>) {
        if (session.closed) return
        session.closed = true
        try {
          if (finalCard) {
            await session.update(finalCard)
          }
          if (cardId) {
            await enqueue(async () => {
              if (!cardId) return
              sequence += 1
              await runtime.finishCardEntityStreaming(cardId, sequence)
            })
          }
        } finally {
          finishResolve()
          await result.catch(() => {})
        }
      },
      abandon() {
        if (session.closed) return
        abandoned = true
        session.closed = true
        finishResolve()
      },
    }

    result.catch((error: Error) => {
      this.logger.error(`[feishu stream ${task.taskId}] ${error.message}`)
    })

    return session
  }

  private async ensureStreamCardSession(task: BridgeTaskState): Promise<FeishuCardSession> {
    const existing = this.cardSessions.get(task.taskId)
    if (existing) return existing

    const session = await this.startStreamCardSession(task, this.buildReplyTarget(task))
    return session
  }

  private async startStreamCardSession(
    task: BridgeTaskState,
    replyTarget: DispatchReplyTarget,
  ): Promise<FeishuCardSession> {
    const session = this.createCardSession(task, replyTarget)
    this.cardSessions.set(task.taskId, session)
    await session.ready
    task.bridgeMessageId = session.messageId
    task.updatedAt = new Date().toISOString()
    const conversation = this.state.conversations[task.threadKey]
    if (conversation) {
      conversation.lastBridgeMessageId = session.messageId
      conversation.updatedAt = task.updatedAt
    }
    await this.persistState()
    return session
  }

  private isCardUpdateTooLargeError(error: unknown, card: Record<string, unknown>): boolean {
    const details = error as {
      code?: string | number
      response?: {
        status?: number
        data?: {
          code?: number
        }
      }
      data?: {
        code?: number
      }
    }
    const code = Number(details.response?.data?.code ?? details.data?.code ?? details.code)
    const status = Number(details.response?.status)
    if ([11310, 200860, 300305].includes(code)) return true
    if (status === 413) return true

    const message = this.describeError(error).toLowerCase()
    return [
      'element exceeds the limit',
      'card too large',
      'card over max size',
      'card content exceeds limit',
      'request entity too large',
      'payload too large',
      'content exceeds limit',
      'card exceeds size',
    ].some((needle) => message.includes(needle))
  }

  private isMessageNotCardError(error: unknown): boolean {
    const details = error as {
      code?: string | number
      response?: {
        data?: {
          code?: number
          msg?: string
        }
      }
      data?: {
        code?: number
        msg?: string
      }
    }
    const code = Number(details.response?.data?.code ?? details.data?.code ?? details.code)
    const msg = details.response?.data?.msg ?? details.data?.msg ?? this.describeError(error)
    return code === 230001 && /not a card/i.test(msg)
  }

  private normalizeStreamCursor(task: BridgeTaskState, cursor: BridgeStreamCursor): BridgeStreamCursor {
    const entries = task.streamEntries ?? []
    const entryIndex = Math.max(0, Math.min(cursor.entryIndex, entries.length))
    const entry = entries[entryIndex]
    if (entry?.type === 'text' && cursor.textOffset != null) {
      return {
        entryIndex,
        textOffset: Math.max(0, Math.min(cursor.textOffset, entry.text.length)),
      }
    }
    return { entryIndex }
  }

  private async rotateStreamCardAfterUpdateFailure(
    task: BridgeTaskState,
    cursor: BridgeStreamCursor,
    failedCard: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    if (!this.isCardUpdateTooLargeError(error, failedCard)) {
      throw error
    }

    const previousSession = this.cardSessions.get(task.taskId)
    if (previousSession) {
      previousSession.abandon()
      this.cardSessions.delete(task.taskId)
    }

    const previousMessageId = task.bridgeMessageId
    task.streamCardStart = this.normalizeStreamCursor(task, cursor)
    task.streamCardSequence = (task.streamCardSequence ?? 0) + 1
    task.updatedAt = new Date().toISOString()

    this.logger.error(`[feishu stream ${task.taskId}] card update exceeded size; continuing in a new card`)
    await this.startStreamCardSession(task, {
      chatId: task.chatId,
      replyTo: previousMessageId || task.userMessageId,
      replyInThread: task.replyInThread === true,
    })
  }

  private async sendCard(
    task: BridgeTaskState,
    card: Record<string, unknown>,
    replyTo?: string,
  ): Promise<string> {
    const result = await this.channel.send(
      task.chatId,
      { card },
      {
        replyTo,
        replyInThread: task.replyInThread === true,
      },
    )

    task.bridgeMessageId = result.messageId
    task.updatedAt = new Date().toISOString()
    const conversation = this.state.conversations[task.threadKey]
    if (conversation) {
      conversation.lastBridgeMessageId = result.messageId
      conversation.updatedAt = task.updatedAt
    }
    await this.persistState()
    return result.messageId
  }

  private async sendOrUpdateTerminalCard(
    task: BridgeTaskState,
    options: {
      allowNewMessageFallback?: boolean
      includeReplay?: boolean
    } = {},
  ): Promise<void> {
    const allowNewMessageFallback = options.allowNewMessageFallback !== false
    const finalCard = this.buildTerminalCard(task, { includeReplay: options.includeReplay })
    const buildCompactFinalCard = () => this.buildTerminalCard(task, { includeReplay: false })
    const session = this.cardSessions.get(task.taskId)
    if (session) {
      await session.close(finalCard).catch(async (error) => {
        if (!this.isCardUpdateTooLargeError(error, finalCard)) throw error
        task.streamCardStart = this.captureStreamCursorForAppend(task, 'status')
        task.streamCardSequence = (task.streamCardSequence ?? 0) + 1
        const compactCard = buildCompactFinalCard()
        if (task.bridgeMessageId) {
          await this.channel.updateCard(task.bridgeMessageId, compactCard).catch(async (compactError) => {
            if (!allowNewMessageFallback) {
              this.logger.error(`[feishu terminal ${task.taskId}] skipped compact card update: ${this.describeError(compactError)}`)
              return
            }
            await this.sendCard(task, compactCard, task.bridgeMessageId || task.userMessageId)
          })
          return
        }
        if (allowNewMessageFallback) {
          await this.sendCard(task, compactCard, task.userMessageId)
        }
      })
      this.cardSessions.delete(task.taskId)
      await this.persistState()
      return
    }

    if (task.bridgeMessageId) {
      await this.channel.updateCard(task.bridgeMessageId, finalCard).catch(async (error) => {
        if (!allowNewMessageFallback && this.isMessageNotCardError(error)) {
          this.logger.error(`[feishu terminal ${task.taskId}] skipped historical card update because bridgeMessageId is not a card: ${task.bridgeMessageId}`)
          return
        }
        if (this.isCardUpdateTooLargeError(error, finalCard)) {
          task.streamCardStart = this.captureStreamCursorForAppend(task, 'status')
          task.streamCardSequence = (task.streamCardSequence ?? 0) + 1
          const compactCard = buildCompactFinalCard()
          await this.channel.updateCard(task.bridgeMessageId!, compactCard).catch(async (compactError) => {
            if (!allowNewMessageFallback) {
              this.logger.error(`[feishu terminal ${task.taskId}] skipped historical compact card update: ${this.describeError(compactError)}`)
              return
            }
            await this.sendCard(task, compactCard, task.bridgeMessageId || task.userMessageId)
          })
          return
        }
        if (allowNewMessageFallback) {
          await this.sendCard(task, buildCompactFinalCard(), task.userMessageId)
        }
      })
      return
    }

    if (!allowNewMessageFallback) return
    await this.sendCard(task, finalCard, task.userMessageId).catch(async (error) => {
      if (!this.isCardUpdateTooLargeError(error, finalCard)) throw error
      await this.sendCard(task, buildCompactFinalCard(), task.userMessageId)
    })
  }

  private async updateStreamingCard(taskId: string, splitCursor?: BridgeStreamCursor): Promise<void> {
    const previous = this.streamCardUpdateChains.get(taskId) ?? Promise.resolve()
    const next = previous
      .catch(() => {})
      .then(() => this.updateStreamingCardNow(taskId, splitCursor))
    this.streamCardUpdateChains.set(taskId, next)
    try {
      await next
    } finally {
      if (this.streamCardUpdateChains.get(taskId) === next) {
        this.streamCardUpdateChains.delete(taskId)
      }
    }
  }

  private async waitForStreamCardUpdates(taskId: string): Promise<void> {
    await (this.streamCardUpdateChains.get(taskId) ?? Promise.resolve()).catch((error: Error) => {
      this.logger.error(`[feishu stream ${taskId}] pending card update failed before terminal update: ${this.describeError(error)}`)
    })
  }

  private async updateStreamingCardNow(taskId: string, splitCursor?: BridgeStreamCursor): Promise<void> {
    const task = this.state.tasks[taskId]
    if (!task) return
    const session = await this.ensureStreamCardSession(task)
    task.updatedAt = new Date().toISOString()
    const nextCard = this.buildStreamingCard(task)
    try {
      await session.update(nextCard)
    } catch (error) {
      await this.rotateStreamCardAfterUpdateFailure(
        task,
        splitCursor ?? this.captureStreamCursorForAppend(task, 'status'),
        nextCard,
        error,
      )
    }
    await this.persistState()
  }

  private async addReceivedReaction(task: BridgeTaskState): Promise<void> {
    if (task.receivedReactionId) return
    for (const emoji of RECEIVED_REACTION_CANDIDATES) {
      try {
        task.receivedReactionId = await this.channel.addReaction(task.userMessageId, emoji)
        task.updatedAt = new Date().toISOString()
        await this.persistState()
        return
      } catch {
        // Try the next candidate.
      }
    }
  }

  private async clearReceivedReaction(task: BridgeTaskState): Promise<void> {
    if (!task.receivedReactionId) return
    const reactionId = task.receivedReactionId
    task.receivedReactionId = undefined
    task.updatedAt = new Date().toISOString()
    await this.channel.removeReaction(task.userMessageId, reactionId).catch(() => {})
    await this.persistState()
  }

  private async addTypingReaction(task: BridgeTaskState): Promise<void> {
    if (task.ackReactionId) return
    for (const emoji of TYPING_REACTION_CANDIDATES) {
      try {
        task.ackReactionId = await this.channel.addReaction(task.userMessageId, emoji)
        task.updatedAt = new Date().toISOString()
        await this.persistState()
        return
      } catch {
        // Try the next candidate.
      }
    }
  }

  private async clearTypingReaction(task: BridgeTaskState): Promise<void> {
    if (!task.ackReactionId) return
    const reactionId = task.ackReactionId
    task.ackReactionId = undefined
    task.updatedAt = new Date().toISOString()
    await this.channel.removeReaction(task.userMessageId, reactionId).catch(() => {})
    await this.persistState()
  }

  private async handleTaskAck(task: TaskAck): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state) return
    if (!this.liveTaskIds.has(task.taskId)) return
    if (state.status === 'help_needed' || state.status === 'completed' || state.status === 'rejected' || state.status === 'failed') {
      return
    }
    state.status = 'pending'
    state.statusLabel = 'Agent is thinking'
    state.updatedAt = new Date().toISOString()
    await this.clearReceivedReaction(state)
    await this.addTypingReaction(state)
    await this.persistState()
  }

  private async handleTaskStreamOpened(task: TaskStreamOpened): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state) return
    if (!this.liveTaskIds.has(task.taskId)) return
    if (state.status === 'help_needed' || state.status === 'completed' || state.status === 'rejected' || state.status === 'failed') {
      return
    }
    state.streamId = task.streamId
    state.status = 'streaming'
    state.statusLabel = '正在回复...'
    state.updatedAt = new Date().toISOString()
    await this.ensureStreamCardSession(state)
    await this.subscribeToTaskStream(state)
    await this.persistState()
  }

  private async subscribeToTaskStream(task: BridgeTaskState): Promise<void> {
    if (!task.streamId || this.activeStreamSubscriptions.has(task.taskId)) return
    const subscription = await this.aamp.subscribeStream(
      task.streamId,
      {
        onEvent: (event) => {
          void this.handleStreamEvent(task.taskId, event)
        },
        onError: (error) => {
          this.logger.error(`[stream ${task.taskId}] ${error.message}`)
        },
      },
      task.lastStreamEventId ? { lastEventId: task.lastStreamEventId } : {},
    )
    this.activeStreamSubscriptions.set(task.taskId, subscription)
  }

  private async handleStreamEvent(taskId: string, event: AampStreamEvent): Promise<void> {
    const task = this.state.tasks[taskId]
    if (!task) return
    if (!this.liveTaskIds.has(taskId)) return

    task.lastStreamEventId = event.id
    task.updatedAt = new Date().toISOString()

    if (event.type === 'text.delta') {
      const splitCursor = this.captureStreamCursorForAppend(task, 'text')
      const text = this.readStreamPayloadText(event.payload)
      this.appendTextDelta(task, text)
      task.status = 'streaming'
      task.statusLabel = '正在回复...'
      await this.updateStreamingCard(taskId, splitCursor)
      return
    }

    if (event.type === 'todo') {
      const splitCursor = this.captureStreamCursorForAppend(task, 'status')
      task.statusLabel = this.readStreamPayloadString(event.payload, ['summary', 'label', 'message', 'text']) || '正在回复...'
      await this.updateStreamingCard(taskId, splitCursor)
      return
    }

    if (event.type === 'tool_call') {
      const splitCursor = this.captureStreamCursorForAppend(task, 'tool')
      this.appendToolProgress(task, event.payload)
      task.status = 'streaming'
      task.statusLabel = '正在回复...'
      await this.updateStreamingCard(taskId, splitCursor)
      return
    }

    if (event.type === 'artifact') {
      const splitCursor = this.captureStreamCursorForAppend(task, 'status')
      task.progressLabel = this.readStreamPayloadString(event.payload, ['label', 'filename', 'url', 'message'])
      await this.updateStreamingCard(taskId, splitCursor)
      return
    }

    await this.persistState()
  }

  private readStreamPayloadString(payload: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = payload[key]
      if (typeof value === 'string' && value.length > 0) return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    }
    return ''
  }

  private readStreamPayloadText(payload: Record<string, unknown>): string {
    return this.readStreamPayloadString(payload, [
      'text',
      'delta',
      'text_delta',
      'textDelta',
      'content_delta',
      'contentDelta',
      'content',
      'message',
      'output',
    ])
  }

  private async handleTaskResult(task: TaskResult): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state) return
    const isLiveTask = this.liveTaskIds.has(task.taskId)
    const wasResultTerminal = state.status === 'completed' || state.status === 'rejected'
    this.closeActiveStream(task.taskId)
    state.status = task.status === 'completed' ? 'completed' : 'rejected'
    state.outputText = task.output || state.outputText
    state.resultError = task.errorMsg
    state.statusLabel = task.status === 'completed' ? 'Completed' : 'Rejected'
    state.updatedAt = new Date().toISOString()
    if (!isLiveTask && wasResultTerminal) {
      await this.persistState()
      return
    }
    await this.waitForStreamCardUpdates(task.taskId)
    await this.sendOrUpdateTerminalCard(state, {
      allowNewMessageFallback: isLiveTask,
      includeReplay: isLiveTask,
    })
    const attachmentOutcome = !isLiveTask || wasResultTerminal
      ? { sent: [], failed: [] }
      : await this.sendResultAttachments(state, task.attachments)
    if (attachmentOutcome.failed.length > 0) {
      await this.channel.send(
        state.chatId,
        {
          markdown: this.sanitizeCardText([
            '有附件没有发出来：',
            ...attachmentOutcome.failed.map((item) => `- ${item}`),
          ].join('\n')),
        },
        {
          replyTo: state.bridgeMessageId || state.userMessageId,
            replyInThread: state.replyInThread === true,
        },
      ).catch((error: Error) => {
        this.logger.error(`[aamp->feishu attachment note ${task.taskId}] ${error.message}`)
      })
    }
    await this.clearReceivedReaction(state)
    await this.clearTypingReaction(state)
    this.liveTaskIds.delete(task.taskId)
  }

  private async handleTaskHelp(task: TaskHelp): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state) return
    const isLiveTask = this.liveTaskIds.has(task.taskId)
    if (state.status === 'completed' || state.status === 'rejected') return
    if (!isLiveTask) return
    this.closeActiveStream(task.taskId)
    state.status = 'help_needed'
    state.helpQuestion = task.question
    state.blockedReason = task.blockedReason
    state.helpSuggestedOptions = task.suggestedOptions.flatMap((option) =>
      option.includes('|') ? option.split('|').map((item) => item.trim()).filter(Boolean) : [option],
    )
    state.statusLabel = 'Agent needs more information'
    state.updatedAt = new Date().toISOString()
    await this.waitForStreamCardUpdates(task.taskId)

    const session = this.cardSessions.get(task.taskId)
    if (session) {
      await session.close(this.buildHelpPreludeCard(state))
      this.cardSessions.delete(task.taskId)
    }

    await this.clearReceivedReaction(state)
    await this.clearTypingReaction(state)
    await this.sendHelpCard(state)
  }

  private async sendHelpCard(task: BridgeTaskState): Promise<void> {
    const result = await this.channel.send(
      task.chatId,
      {
        card: this.buildHelpCard(task),
      },
      {
        replyTo: task.bridgeMessageId || task.userMessageId,
        replyInThread: task.replyInThread === true,
      },
    )

    task.helpCardMessageId = result.messageId
    task.updatedAt = new Date().toISOString()
    const conversation = this.state.conversations[task.threadKey]
    if (conversation) {
      conversation.lastBridgeMessageId = result.messageId
      conversation.updatedAt = task.updatedAt
    }
    await this.persistState()
  }

  private buildHelpCard(
    task: BridgeTaskState,
    options: {
      submittedResponse?: string
      submissionState?: 'submitted' | 'stale' | 'failed'
    } = {},
  ): Record<string, unknown> {
    const submittedResponse = options.submittedResponse?.trim()
    const statusText = options.submissionState === 'submitted'
      ? `已收到你的补充：${submittedResponse}`
      : options.submissionState === 'stale'
        ? `这张卡片已经过期，你点击的是：${submittedResponse}`
        : options.submissionState === 'failed'
          ? `提交失败，请直接在会话里继续回复。最近一次尝试：${submittedResponse}`
          : '可以直接点一个建议项，也可以继续发送文字或附件。'

    const actionButtons = (task.helpSuggestedOptions ?? []).slice(0, 5).map((option) => ({
      tag: 'button',
      text: {
        tag: 'plain_text',
        content: option,
      },
      type: option === task.helpSuggestedOptions?.[0] ? 'primary' : 'default',
      value: {
        kind: 'help_reply',
        taskId: task.taskId,
        response: option,
      },
    }))

    return {
      schema: '2.0',
      config: {
        wide_screen_mode: true,
      },
      body: {
        direction: 'vertical',
        vertical_spacing: '12px',
        elements: [
          {
            tag: 'markdown',
            content: [
              '我还需要一些信息。',
              ...(task.helpQuestion ? ['', task.helpQuestion] : []),
              ...(task.blockedReason ? ['', `原因：${task.blockedReason}`] : []),
              '',
              statusText,
            ].filter(Boolean).join('\n'),
          },
          ...(actionButtons.length && !options.submissionState
            ? [{
                tag: 'action',
                actions: actionButtons,
              }]
            : []),
        ],
      },
    }
  }

  private closeActiveStream(taskId: string): void {
    const subscription = this.activeStreamSubscriptions.get(taskId)
    if (subscription) {
      subscription.close()
      this.activeStreamSubscriptions.delete(taskId)
    }
  }

  private restoreLiveTasksFromState(): void {
    this.liveTaskIds.clear()
    for (const task of Object.values(this.state.tasks)) {
      if (!isTerminalTaskStatus(task.status)) {
        this.liveTaskIds.add(task.taskId)
      }
    }
  }

  private async resumeActiveStreams(): Promise<void> {
    for (const task of Object.values(this.state.tasks)) {
      if (isTerminalTaskStatus(task.status) || !task.streamId) continue
      await this.subscribeToTaskStream(task).catch((error: Error) => {
        this.logger.error(`[stream ${task.taskId}] failed to resume stream subscription: ${this.describeError(error)}`)
      })
    }
  }

  private async reconcileRecentMailbox(includeHistorical: boolean): Promise<void> {
    await this.aamp.reconcileRecentEmails(100, includeHistorical ? { includeHistorical: true } : undefined)
      .catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[aamp reconcile] ${error.message}`)
      })
  }

  private setConnectivity(kind: 'aamp' | 'feishu', value: BridgeState['connectivity'][typeof kind]): void {
    this.state.connectivity[kind] = value
  }

  private async persistState(): Promise<void> {
    await saveBridgeState(this.state, this.configDir)
  }
}
