import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  AampClient,
  type AampAttachment,
  type AampStreamEvent,
  type StreamSubscription,
  type TaskAck,
  type TaskHelp,
  type TaskResult,
  type TaskStreamOpened,
} from 'aamp-sdk'
import {
  LoggerLevel,
  type BotIdentity,
  type CardActionEvent,
  type CardStreamController,
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
import type {
  BridgeConfig,
  BridgeConversationState,
  BridgeState,
  BridgeTaskState,
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
  closed: boolean
  currentCard: Record<string, unknown>
  ready: Promise<void>
  result: Promise<void>
  update(nextCard: Record<string, unknown>): Promise<void>
  close(finalCard?: Record<string, unknown>): Promise<void>
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

const RECEIVED_REACTION_CANDIDATES = ['Get']
const TYPING_REACTION_CANDIDATES = ['Typing']

export class FeishuBridgeRuntime {
  private readonly aamp: AampClient
  private readonly channel: LarkChannel
  private readonly config: BridgeConfig
  private readonly configDir?: string
  private readonly logger: Pick<Console, 'log' | 'error'>
  private state: BridgeState = createDefaultBridgeState()
  private readonly activeStreamSubscriptions = new Map<string, StreamSubscription>()
  private readonly cardSessions = new Map<string, FeishuCardSession>()
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
    this.channel = createLarkChannel({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
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
    this.expirePendingTasksFromPreviousRun()
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
    this.channel.on('message', (message) => {
      void this.handleIncomingMessage(message).catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[feishu->aamp] ${error.message}`)
        void this.persistState()
      })
    })
    this.channel.on('cardAction', (event) => {
      void this.handleCardAction(event).catch((error: Error) => {
        this.state.lastError = error.message
        this.logger.error(`[feishu card] ${error.message}`)
        void this.persistState()
      })
    })
    this.channel.on('error', (error) => {
      this.state.lastError = error.message
      this.logger.error(`[feishu] ${error.message}`)
      void this.persistState()
    })
    this.channel.on('reconnecting', () => {
      this.setConnectivity('feishu', 'connecting')
      void this.persistState()
    })
    this.channel.on('reconnected', () => {
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
    const root = message.threadId || message.rootId || message.replyToMessageId || message.messageId
    return `group:${message.chatId}:${root}`
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
    const attachmentBundle = await this.prepareAttachments(message.resources)
    const bodyText = this.buildDispatchBody(message, attachmentBundle.notes)
    const dispatchContext = this.buildDispatchContext(message)

    const task = this.createTaskState({
      chatId: message.chatId,
      chatType: message.chatType,
      senderId: message.senderId,
      senderName: message.senderName,
      userMessageId: message.messageId,
      userMessageText: message.content,
      parentTaskId,
    }, threadKey, randomUUID(), title)

    await this.dispatchTask(task, {
      bodyText,
      dispatchContext,
      attachments: attachmentBundle.attachments,
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
    const attachmentBundle = await this.prepareAttachments(message.resources)
    const bodyText = this.buildHelpResponseBody(helpTask, responseText, attachmentBundle.notes)
    const dispatchContext = {
      ...this.buildDispatchContext(message),
      source_kind: 'help_reply',
      reply_to_task_id: helpTask.taskId,
    }

    const task = this.createTaskState({
      chatId: message.chatId,
      chatType: message.chatType,
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

  private buildDispatchBody(message: NormalizedMessage, notes: string[] = []): string {
    const resourceLines = message.resources.map((resource) => `- ${resource.type}: ${resource.fileName || resource.fileKey}`)
    return [
      `Feishu ${message.chatType === 'p2p' ? 'direct message' : 'group mention'}:`,
      '',
      message.content.trim() || '(empty message)',
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
      replyInThread: task.chatType === 'group',
    }
  }

  private buildCardShell(elements: Record<string, unknown>[]): Record<string, unknown> {
    return {
      schema: '2.0',
      config: {
        wide_screen_mode: true,
      },
      body: {
        direction: 'vertical',
        vertical_spacing: '12px',
        elements,
      },
    }
  }

  private buildStreamingCard(task: BridgeTaskState): Record<string, unknown> {
    const content = this.sanitizeCardText(task.streamText?.trim() || '_正在输入..._')
    const statusText = this.buildStreamingStatusText(task)
    return this.buildCardShell([
      {
        tag: 'markdown',
        content,
      },
      ...(statusText
        ? [{
            tag: 'markdown',
            content: this.sanitizeCardText(`_${statusText}_`),
          } satisfies Record<string, unknown>]
        : []),
    ])
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

    if (task.streamText?.trim()) {
      elements.push(this.buildCollapsiblePanel('刚才的过程', task.streamText))
    }

    return this.buildCardShell(elements)
  }

  private buildTerminalCard(task: BridgeTaskState): Record<string, unknown> {
    if (task.status === 'completed') {
      return this.buildResultCard(task)
    }
    return this.buildErrorCard(task)
  }

  private buildResultCard(task: BridgeTaskState): Record<string, unknown> {
    const finalText = this.renderCompletedMarkdown(task)
    const streamText = task.streamText?.trim()
    const elements: Record<string, unknown>[] = []
    if (streamText && this.shouldShowReplayPanel(streamText, finalText)) {
      elements.push(this.buildCollapsiblePanel('过程回放', streamText))
    }
    elements.push({
      tag: 'markdown',
      content: finalText,
    })
    return this.buildCardShell(elements)
  }

  private buildErrorCard(task: BridgeTaskState): Record<string, unknown> {
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
    if (streamText && this.shouldShowReplayPanel(streamText, lines.join('\n'))) {
      elements.push(this.buildCollapsiblePanel('过程回放', streamText))
    }
    elements.push({
      tag: 'markdown',
      content: this.sanitizeCardText(lines.join('\n')),
    })
    return this.buildCardShell(elements)
  }

  private buildCollapsiblePanel(title: string, content: string): Record<string, unknown> {
    return {
      tag: 'collapsible_panel',
      expanded: false,
      element_id: `panel_${Math.abs(this.hashString(title)).toString(36).slice(0, 8)}`,
      header: {
        title: {
          tag: 'plain_text',
          content: title,
        },
        icon: {
          tag: 'standard_icon',
          token: 'down-small-ccm_outlined',
          size: '16px 16px',
        },
        icon_position: 'right',
        icon_expanded_angle: -180,
      },
      border: {
        color: 'grey',
        corner_radius: '5px',
      },
      elements: [
        {
          tag: 'markdown',
          element_id: `panelc_${Math.abs(this.hashString(`${title}:${content.length}`)).toString(36).slice(0, 8)}`,
          content: this.sanitizeCardText(content.trim()),
        },
      ],
    }
  }

  private renderCompletedMarkdown(task: BridgeTaskState): string {
    return this.sanitizeCardText(task.outputText.trim() || task.streamText?.trim() || '已经处理完成。')
  }

  private buildStreamingStatusText(task: BridgeTaskState): string {
    if (task.progressLabel?.trim()) return task.progressLabel.trim()
    if (task.statusLabel?.trim()) return task.statusLabel.trim()
    return '正在回复...'
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

  private async prepareAttachments(resources: ResourceDescriptor[]): Promise<PreparedAttachments> {
    const attachments: AampAttachment[] = []
    const notes: string[] = []

    for (const resource of resources) {
      if (resource.type !== 'image' && resource.type !== 'file') {
        notes.push(`Skipped ${resource.type} resource ${resource.fileName || resource.fileKey}: unsupported by bridge uploader.`)
        continue
      }

      try {
        const content = await this.channel.downloadResource(resource.fileKey, resource.type)
        const filename = this.resolveAttachmentFilename(resource)
        attachments.push({
          filename,
          contentType: this.resolveAttachmentContentType(resource, filename),
          content,
          size: content.byteLength,
        })
      } catch (error) {
        notes.push(`Failed to download ${resource.type} resource ${resource.fileName || resource.fileKey}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    return { attachments, notes }
  }

  private resolveAttachmentFilename(resource: ResourceDescriptor): string {
    const fallbackBase = resource.type === 'image' ? 'feishu-image' : 'feishu-file'
    const baseName = resource.fileName?.trim() || `${fallbackBase}-${resource.fileKey.slice(0, 8)}`
    if (path.extname(baseName)) return baseName
    if (resource.type === 'image') return `${baseName}.png`
    return baseName
  }

  private resolveAttachmentContentType(resource: ResourceDescriptor, filename: string): string {
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

  private createCardSession(task: BridgeTaskState, replyTarget: DispatchReplyTarget): FeishuCardSession {
    let controllerRef: CardStreamController | undefined
    let readyResolve!: () => void
    let finishResolve!: () => void
    let chain = Promise.resolve()
    let currentCard = this.buildStreamingCard(task)

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

    const result = this.channel.stream(
      replyTarget.chatId,
      {
        card: {
          initial: currentCard,
          producer: async (controller) => {
            controllerRef = controller
            readyResolve()
            await finish
          },
        },
      },
      {
        replyTo: replyTarget.replyTo,
        replyInThread: replyTarget.replyInThread,
      },
    ).then(() => undefined)

    const session: FeishuCardSession = {
      closed: false,
      get messageId() {
        return controllerRef?.messageId
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
        currentCard = nextCard
        if (!controllerRef) {
          await ready
        }
        await enqueue(() => controllerRef!.update(nextCard))
      },
      async close(finalCard?: Record<string, unknown>) {
        if (session.closed) return
        session.closed = true
        if (finalCard) {
          if (!controllerRef) {
            await ready
          }
          currentCard = finalCard
          await enqueue(() => controllerRef!.update(finalCard))
        }
        finishResolve()
        await result.catch(() => {})
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

    const session = this.createCardSession(task, this.buildReplyTarget(task))
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
        replyInThread: task.chatType === 'group',
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

  private async sendOrUpdateTerminalCard(task: BridgeTaskState): Promise<void> {
    const finalCard = this.buildTerminalCard(task)
    const session = this.cardSessions.get(task.taskId)
    if (session) {
      await session.close(finalCard)
      this.cardSessions.delete(task.taskId)
      await this.persistState()
      return
    }

    if (task.bridgeMessageId) {
      await this.channel.updateCard(task.bridgeMessageId, finalCard).catch(async () => {
        await this.sendCard(task, finalCard, task.userMessageId)
      })
      return
    }

    await this.sendCard(task, finalCard, task.userMessageId)
  }

  private async updateStreamingCard(taskId: string): Promise<void> {
    const task = this.state.tasks[taskId]
    if (!task) return
    const session = await this.ensureStreamCardSession(task)
    task.updatedAt = new Date().toISOString()
    await session.update(this.buildStreamingCard(task))
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
      const text = String(event.payload.text ?? '')
      task.streamText = (task.streamText ?? '') + text
      task.status = 'streaming'
      task.statusLabel = '正在回复...'
      await this.updateStreamingCard(taskId)
      return
    }

    if (event.type === 'status') {
      task.statusLabel = String(event.payload.label ?? event.payload.stage ?? '正在回复...')
      await this.updateStreamingCard(taskId)
      return
    }

    if (event.type === 'progress') {
      task.progressLabel = String(event.payload.label ?? '')
      await this.updateStreamingCard(taskId)
      return
    }

    if (event.type === 'error') {
      task.resultError = String(event.payload.message ?? event.payload.error ?? 'Unknown stream error')
      await this.updateStreamingCard(taskId)
      return
    }

    if (event.type === 'done') {
      task.statusLabel = '正在整理最终回复...'
      await this.updateStreamingCard(taskId)
      return
    }

    await this.persistState()
  }

  private async handleTaskResult(task: TaskResult): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state) return
    if (!this.liveTaskIds.has(task.taskId)) return
    state.status = task.status === 'completed' ? 'completed' : 'rejected'
    state.outputText = task.output || state.outputText
    state.resultError = task.errorMsg
    state.statusLabel = task.status === 'completed' ? 'Completed' : 'Rejected'
    state.updatedAt = new Date().toISOString()
    this.closeActiveStream(task.taskId)
    await this.sendOrUpdateTerminalCard(state)
    await this.clearReceivedReaction(state)
    await this.clearTypingReaction(state)
    this.liveTaskIds.delete(task.taskId)
  }

  private async handleTaskHelp(task: TaskHelp): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state) return
    if (!this.liveTaskIds.has(task.taskId)) return
    state.status = 'help_needed'
    state.helpQuestion = task.question
    state.blockedReason = task.blockedReason
    state.helpSuggestedOptions = task.suggestedOptions.flatMap((option) =>
      option.includes('|') ? option.split('|').map((item) => item.trim()).filter(Boolean) : [option],
    )
    state.statusLabel = 'Agent needs more information'
    state.updatedAt = new Date().toISOString()
    this.closeActiveStream(task.taskId)

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
        replyInThread: task.chatType === 'group',
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

  private expirePendingTasksFromPreviousRun(): void {
    for (const task of Object.values(this.state.tasks)) {
      if (task.status === 'completed' || task.status === 'rejected' || task.status === 'failed') continue
      task.status = 'failed'
      task.statusLabel = 'Expired after bridge restart'
      task.streamId = undefined
      task.lastStreamEventId = undefined
      task.helpQuestion = undefined
      task.blockedReason = undefined
      task.helpSuggestedOptions = undefined
      task.helpCardMessageId = undefined
      task.updatedAt = new Date().toISOString()
    }
  }

  private setConnectivity(kind: 'aamp' | 'feishu', value: BridgeState['connectivity'][typeof kind]): void {
    this.state.connectivity[kind] = value
  }

  private async persistState(): Promise<void> {
    await saveBridgeState(this.state, this.configDir)
  }
}
