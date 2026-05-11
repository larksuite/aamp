import { randomUUID } from 'node:crypto'
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
  createDefaultBridgeState,
  loadBridgeState,
  saveBridgeState,
} from './config.js'
import {
  getTypingTicket,
  getUpdates,
  notifyStart,
  notifyStop,
  sendTextMessage,
  sendTypingStatus,
  type WechatMessage,
  type WechatMessageItem,
} from './wechat-api.js'
import type {
  BridgeConfig,
  BridgeState,
  BridgeTaskState,
} from './types.js'

interface WechatBridgeRuntimeOptions {
  configDir?: string
  logger?: Pick<Console, 'log' | 'error'>
}

const MAX_PROCESSED_MESSAGE_IDS = 200

export class WechatBridgeRuntime {
  private readonly aamp: AampClient
  private readonly config: BridgeConfig
  private readonly configDir?: string
  private readonly logger: Pick<Console, 'log' | 'error'>
  private readonly activeStreamSubscriptions = new Map<string, StreamSubscription>()
  private readonly liveTaskIds = new Set<string>()
  private readonly typingTickets = new Map<string, string>()
  private state: BridgeState = createDefaultBridgeState()
  private stopping = false
  private pollLoopPromise?: Promise<void>

  constructor(config: BridgeConfig, options: WechatBridgeRuntimeOptions = {}) {
    this.config = config
    this.configDir = options.configDir
    this.logger = options.logger ?? console
    this.aamp = new AampClient({
      email: config.mailbox.email,
      mailboxToken: config.mailbox.mailboxToken,
      smtpPassword: config.mailbox.smtpPassword,
      baseUrl: config.mailbox.baseUrl,
    })
  }

  async start(): Promise<void> {
    this.state = await loadBridgeState(this.configDir)
    if (!this.state.account?.token) {
      throw new Error('尚未登录微信，请先执行 `aamp-wechat-bridge login`。')
    }
    this.state.tasks = {}
    this.state.lastStartedAt = new Date().toISOString()
    this.state.lastError = undefined
    await this.persistState()

    this.registerAampHandlers()
    await this.aamp.connect()
    await notifyStart({
      apiBaseUrl: this.state.account.baseUrl,
      token: this.state.account.token,
      botAgent: this.config.wechat.botAgent,
      timeoutMs: 10000,
    }).catch(() => {})

    this.pollLoopPromise = this.pollLoop()
    await this.pollLoopPromise
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true

    for (const subscription of this.activeStreamSubscriptions.values()) {
      subscription.close()
    }
    this.activeStreamSubscriptions.clear()
    this.liveTaskIds.clear()

    if (this.state.account?.token) {
      await notifyStop({
        apiBaseUrl: this.state.account.baseUrl,
        token: this.state.account.token,
        botAgent: this.config.wechat.botAgent,
        timeoutMs: 10000,
      }).catch(() => {})
    }

    this.aamp.disconnect()
    this.state.lastStoppedAt = new Date().toISOString()
    await this.persistState()
  }

  private registerAampHandlers(): void {
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
    this.aamp.on('error', (error) => {
      this.state.lastError = error.message
      this.logger.error(`[aamp] ${error.message}`)
      void this.persistState()
    })
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.state.lastError = message
        this.logger.error(`[wechat] ${message}`)
        await this.persistState()
        if (message.includes('session timeout') || message.includes('errcode=-14')) {
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
    }
  }

  private async pollOnce(): Promise<void> {
    if (!this.state.account?.token) return
    const response = await getUpdates({
      apiBaseUrl: this.state.account.baseUrl,
      token: this.state.account.token,
      botAgent: this.config.wechat.botAgent,
      timeoutMs: this.config.behavior.pollTimeoutMs,
      syncCursor: this.state.syncCursor,
    })

    if (response.errcode === -14) {
      throw new Error('WeChat session timeout (errcode=-14). Please run `aamp-wechat-bridge login` again.')
    }
    if (response.ret && response.ret !== 0) {
      throw new Error(`WeChat getupdates failed: errcode=${response.errcode ?? response.ret} ${response.errmsg ?? ''}`.trim())
    }

    if (response.get_updates_buf && response.get_updates_buf !== this.state.syncCursor) {
      this.state.syncCursor = response.get_updates_buf
      await this.persistState()
    }

    for (const message of response.msgs ?? []) {
      await this.handleInboundWechatMessage(message)
    }
  }

  private async handleInboundWechatMessage(message: WechatMessage): Promise<void> {
    if (message.group_id) return
    if (message.message_type === 2) return
    const senderId = message.from_user_id?.trim()
    if (!senderId) return

    const messageKey = String(message.message_id ?? '')
    if (messageKey && this.state.processedMessageIds.includes(messageKey)) {
      return
    }

    const text = this.extractMessageText(message.item_list ?? [])
    const mediaNote = this.extractMediaNote(message.item_list ?? [])
    const body = [text, mediaNote].filter(Boolean).join('\n\n').trim()
    if (!body) return

    const taskId = randomUUID()
    const sessionKey = this.buildSessionKey(senderId)
    const contextToken = message.context_token?.trim() || undefined
    const now = new Date().toISOString()

    this.liveTaskIds.add(taskId)
    this.state.tasks[taskId] = {
      taskId,
      senderId,
      sessionKey,
      ...(contextToken ? { contextToken } : {}),
      status: 'received',
      createdAt: now,
      updatedAt: now,
    }
    this.state.conversations[sessionKey] = {
      senderId,
      sessionKey,
      lastTaskId: taskId,
      ...(contextToken ? { lastContextToken: contextToken } : {}),
      updatedAt: now,
    }
    if (contextToken) {
      this.state.contextTokens[senderId] = contextToken
    }
    if (messageKey) {
      this.rememberProcessedMessageId(messageKey)
    }
    await this.persistState()

    await this.aamp.sendTask({
      to: this.config.targetAgentEmail,
      taskId,
      sessionKey,
      title: `WeChat DM from ${senderId}`,
      bodyText: body,
      dispatchContext: {
        source: 'wechat',
        wechat_account_id: this.state.account?.accountId ?? 'default',
        wechat_sender_id: senderId,
        ...(contextToken ? { wechat_context_token: contextToken } : {}),
        ...(message.session_id ? { wechat_session_id: message.session_id } : {}),
        ...(message.message_id != null ? { wechat_message_id: String(message.message_id) } : {}),
      },
    })
  }

  private extractMessageText(items: WechatMessageItem[]): string {
    const parts: string[] = []
    for (const item of items) {
      const text = item.text_item?.text?.trim()
      if (text) parts.push(text)
      const voiceText = item.voice_item?.text?.trim()
      if (voiceText) parts.push(voiceText)
    }
    return parts.join('\n').trim()
  }

  private extractMediaNote(items: WechatMessageItem[]): string {
    const labels: string[] = []
    for (const item of items) {
      if (item.type === 2) labels.push('image')
      if (item.type === 3) labels.push('voice')
      if (item.type === 4) labels.push(`file${item.file_item?.file_name ? ` (${item.file_item.file_name})` : ''}`)
      if (item.type === 5) labels.push('video')
    }
    if (labels.length === 0) return ''
    return `User also sent WeChat media: ${labels.join(', ')}. Native media relay is not implemented yet, so please answer based on the textual context only.`
  }

  private buildSessionKey(senderId: string): string {
    return `wechat:${this.state.account?.accountId ?? 'default'}:${senderId}`
  }

  private rememberProcessedMessageId(messageId: string): void {
    this.state.processedMessageIds.push(messageId)
    if (this.state.processedMessageIds.length > MAX_PROCESSED_MESSAGE_IDS) {
      this.state.processedMessageIds.splice(0, this.state.processedMessageIds.length - MAX_PROCESSED_MESSAGE_IDS)
    }
  }

  private async handleTaskAck(task: TaskAck): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state || !this.liveTaskIds.has(task.taskId)) return
    state.status = 'pending'
    state.updatedAt = new Date().toISOString()
    await this.ensureTyping(state, 'typing')
    await this.persistState()
  }

  private async handleTaskStreamOpened(task: TaskStreamOpened): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state || !this.liveTaskIds.has(task.taskId)) return
    state.status = 'streaming'
    state.streamId = task.streamId
    state.updatedAt = new Date().toISOString()
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
    )
    this.activeStreamSubscriptions.set(task.taskId, subscription)
  }

  private async handleStreamEvent(taskId: string, event: AampStreamEvent): Promise<void> {
    const state = this.state.tasks[taskId]
    if (!state || !this.liveTaskIds.has(taskId)) return
    if (event.type === 'text.delta') {
      state.streamText = (state.streamText ?? '') + String(event.payload.text ?? '')
      state.status = 'streaming'
      state.updatedAt = new Date().toISOString()
      await this.persistState()
      return
    }
    if (event.type === 'error') {
      state.resultError = String(event.payload.message ?? event.payload.error ?? 'Unknown stream error')
      state.updatedAt = new Date().toISOString()
      await this.persistState()
    }
  }

  private async handleTaskResult(task: TaskResult): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state || !this.liveTaskIds.has(task.taskId)) return
    state.status = task.status === 'completed' ? 'completed' : 'rejected'
    state.outputText = task.output || state.streamText || state.outputText
    state.resultError = task.errorMsg
    state.updatedAt = new Date().toISOString()
    this.closeActiveStream(task.taskId)
    await this.ensureTyping(state, 'cancel')
    await this.replyToWechat(state, this.buildReplyTextFromResult(task, state))
    this.finishTask(task.taskId)
  }

  private async handleTaskHelp(task: TaskHelp): Promise<void> {
    const state = this.state.tasks[task.taskId]
    if (!state || !this.liveTaskIds.has(task.taskId)) return
    state.status = 'help_needed'
    state.updatedAt = new Date().toISOString()
    this.closeActiveStream(task.taskId)
    await this.ensureTyping(state, 'cancel')
    await this.replyToWechat(state, this.buildReplyTextFromHelp(task))
    this.finishTask(task.taskId)
  }

  private buildReplyTextFromResult(task: TaskResult, state: BridgeTaskState): string {
    const body = (task.output || state.streamText || '').trim()
    const base = body
      || (task.status === 'rejected' ? '当前请求被目标 Agent 拒绝了。' : '已经处理完成。')
    const attachmentLines = (task.attachments ?? []).map((attachment: AampAttachment) => `- ${attachment.filename} (${attachment.size} bytes)`)
    const senderPolicyHint = this.buildSenderPolicyHint(task.errorMsg, state)
    return [
      base,
      ...(attachmentLines.length ? ['', '返回中还包含附件，目前微信 bridge 先只提示文件名：', ...attachmentLines] : []),
      ...(senderPolicyHint ? ['', senderPolicyHint] : []),
    ].join('\n')
  }

  private buildReplyTextFromHelp(task: TaskHelp): string {
    return [
      task.question.trim() || '我还需要一些信息才能继续。',
      ...(task.blockedReason?.trim() ? ['', `原因：${task.blockedReason.trim()}`] : []),
      ...(task.suggestedOptions?.length ? ['', '你可以这样补充：', ...task.suggestedOptions.map((item) => `- ${item}`)] : []),
    ].join('\n')
  }

  private buildSenderPolicyHint(errorMsg: string | undefined, state: BridgeTaskState): string {
    if (!errorMsg?.includes('senderPolicies')) return ''
    return [
      '目标 Agent 当前没有放行这个微信桥。',
      '请在 target agent 的 senderPolicies 中允许当前 bridge 邮箱，并把 `wechat_sender_id` 作为 dispatchContext 白名单条件。',
      '',
      '示例：',
      '[',
      `  {"sender":"${this.config.mailbox.email}","dispatchContextRules":{"wechat_sender_id":["${state.senderId}"]}}`,
      ']',
    ].join('\n')
  }

  private async replyToWechat(task: BridgeTaskState, text: string): Promise<void> {
    if (!this.state.account?.token) return
    await sendTextMessage({
      apiBaseUrl: this.state.account.baseUrl,
      token: this.state.account.token,
      botAgent: this.config.wechat.botAgent,
      timeoutMs: 15000,
      toUserId: task.senderId,
      text,
      contextToken: task.contextToken ?? this.state.contextTokens[task.senderId],
    })
  }

  private async ensureTyping(task: BridgeTaskState, status: 'typing' | 'cancel'): Promise<void> {
    if (!this.state.account?.token) return
    const cachedTicket = this.typingTickets.get(task.senderId)
    const ticket = cachedTicket || await getTypingTicket({
      apiBaseUrl: this.state.account.baseUrl,
      token: this.state.account.token,
      botAgent: this.config.wechat.botAgent,
      timeoutMs: 10000,
      ilinkUserId: task.senderId,
      contextToken: task.contextToken ?? this.state.contextTokens[task.senderId],
    }).catch(() => undefined)
    if (!ticket) return
    this.typingTickets.set(task.senderId, ticket)
    await sendTypingStatus({
      apiBaseUrl: this.state.account.baseUrl,
      token: this.state.account.token,
      botAgent: this.config.wechat.botAgent,
      timeoutMs: 10000,
      ilinkUserId: task.senderId,
      typingTicket: ticket,
      status,
    }).catch(() => {})
    task.typingActive = status === 'typing'
  }

  private closeActiveStream(taskId: string): void {
    const subscription = this.activeStreamSubscriptions.get(taskId)
    if (!subscription) return
    subscription.close()
    this.activeStreamSubscriptions.delete(taskId)
  }

  private finishTask(taskId: string): void {
    this.liveTaskIds.delete(taskId)
    delete this.state.tasks[taskId]
    void this.persistState()
  }

  private async persistState(): Promise<void> {
    await saveBridgeState(this.state, this.configDir)
  }
}
