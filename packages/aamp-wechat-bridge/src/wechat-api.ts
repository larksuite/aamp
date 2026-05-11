import crypto from 'node:crypto'

const DEFAULT_APP_ID = 'bot'
const DEFAULT_CHANNEL_VERSION = '0.1.0'

export interface WechatMessageItem {
  type?: number
  text_item?: {
    text?: string
  }
  voice_item?: {
    text?: string
  }
  file_item?: {
    file_name?: string
  }
}

export interface WechatMessage {
  message_id?: number
  message_type?: number
  from_user_id?: string
  to_user_id?: string
  create_time_ms?: number
  session_id?: string
  group_id?: string
  item_list?: WechatMessageItem[]
  context_token?: string
}

export interface WechatGetUpdatesResponse {
  ret?: number
  errcode?: number
  errmsg?: string
  msgs?: WechatMessage[]
  get_updates_buf?: string
  longpolling_timeout_ms?: number
}

export type WechatQrStatus =
  | 'wait'
  | 'scaned'
  | 'confirmed'
  | 'expired'
  | 'scaned_but_redirect'
  | 'need_verifycode'
  | 'verify_code_blocked'
  | 'binded_redirect'

export interface WechatQrStartResult {
  qrCode: string
  qrCodeUrl: string
}

export interface WechatQrStatusResult {
  status: WechatQrStatus
  botToken?: string
  ilinkUserId?: string
  baseUrl?: string
  redirectHost?: string
}

export interface WechatApiCommonOptions {
  apiBaseUrl: string
  botAgent: string
  token?: string
  timeoutMs?: number
}

export function normalizeWechatApiBaseUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url.replace(/\/$/, '')
  return `https://${url.replace(/\/$/, '')}`
}

function buildClientVersion(version: string): number {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10))
  const major = parts[0] ?? 0
  const minor = parts[1] ?? 0
  const patch = parts[2] ?? 0
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff)
}

function sanitizeBotAgent(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) return 'AAMP-WeChat-Bridge/0.1.0'
  return trimmed.slice(0, 256)
}

function buildBaseInfo(botAgent: string): Record<string, string> {
  return {
    channel_version: DEFAULT_CHANNEL_VERSION,
    bot_agent: sanitizeBotAgent(botAgent),
  }
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'),
    'iLink-App-Id': DEFAULT_APP_ID,
    'iLink-App-ClientVersion': String(buildClientVersion(DEFAULT_CHANNEL_VERSION)),
  }
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`
  }
  return headers
}

async function postJson<T>(
  endpoint: string,
  body: unknown,
  opts: WechatApiCommonOptions,
): Promise<T> {
  const controller = opts.timeoutMs ? new AbortController() : undefined
  const timeout = opts.timeoutMs
    ? setTimeout(() => controller?.abort(), opts.timeoutMs)
    : undefined
  try {
    const response = await fetch(`${normalizeWechatApiBaseUrl(opts.apiBaseUrl)}/${endpoint}`, {
      method: 'POST',
      headers: buildHeaders(opts.token),
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${endpoint} ${response.status}: ${text || response.statusText}`)
    }
    return JSON.parse(text) as T
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function getJson<T>(
  endpoint: string,
  opts: WechatApiCommonOptions,
): Promise<T> {
  const controller = opts.timeoutMs ? new AbortController() : undefined
  const timeout = opts.timeoutMs
    ? setTimeout(() => controller?.abort(), opts.timeoutMs)
    : undefined
  try {
    const response = await fetch(`${normalizeWechatApiBaseUrl(opts.apiBaseUrl)}/${endpoint}`, {
      method: 'GET',
      headers: buildHeaders(opts.token),
      ...(controller ? { signal: controller.signal } : {}),
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`${endpoint} ${response.status}: ${text || response.statusText}`)
    }
    return JSON.parse(text) as T
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export async function startQrLogin(opts: {
  apiBaseUrl: string
  botType: string
  botAgent: string
}): Promise<WechatQrStartResult> {
  const response = await postJson<{
    qrcode?: string
    qrcode_img_content?: string
  }>(
    `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(opts.botType)}`,
    {
      local_token_list: [],
      base_info: buildBaseInfo(opts.botAgent),
    },
    { apiBaseUrl: opts.apiBaseUrl, botAgent: opts.botAgent, timeoutMs: 15000 },
  )

  if (!response.qrcode || !response.qrcode_img_content) {
    throw new Error('微信登录二维码获取失败。')
  }

  return {
    qrCode: response.qrcode,
    qrCodeUrl: response.qrcode_img_content,
  }
}

export async function pollQrStatus(opts: {
  apiBaseUrl: string
  qrCode: string
  botAgent: string
  verifyCode?: string
}): Promise<WechatQrStatusResult> {
  const query = new URLSearchParams({ qrcode: opts.qrCode })
  if (opts.verifyCode) query.set('verify_code', opts.verifyCode)
  const response = await getJson<{
    status?: WechatQrStatus
    bot_token?: string
    ilink_user_id?: string
    baseurl?: string
    redirect_host?: string
  }>(`ilink/bot/get_qrcode_status?${query.toString()}`, {
    apiBaseUrl: opts.apiBaseUrl,
    botAgent: opts.botAgent,
    timeoutMs: 35000,
  })

  return {
    status: response.status ?? 'wait',
    botToken: response.bot_token,
    ilinkUserId: response.ilink_user_id,
    baseUrl: response.baseurl ? normalizeWechatApiBaseUrl(response.baseurl) : undefined,
    redirectHost: response.redirect_host,
  }
}

export async function getUpdates(opts: WechatApiCommonOptions & {
  syncCursor?: string
}): Promise<WechatGetUpdatesResponse> {
  try {
    return await postJson<WechatGetUpdatesResponse>(
      'ilink/bot/getupdates',
      {
        get_updates_buf: opts.syncCursor ?? '',
        base_info: buildBaseInfo(opts.botAgent),
      },
      opts,
    )
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        ret: 0,
        msgs: [],
        get_updates_buf: opts.syncCursor,
      }
    }
    throw error
  }
}

export async function sendTextMessage(opts: WechatApiCommonOptions & {
  toUserId: string
  text: string
  contextToken?: string
}): Promise<void> {
  await postJson(
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: opts.toUserId,
        client_id: crypto.randomUUID(),
        message_type: 2,
        message_state: 2,
        item_list: opts.text
          ? [{ type: 1, text_item: { text: opts.text } }]
          : undefined,
        context_token: opts.contextToken ?? undefined,
      },
      base_info: buildBaseInfo(opts.botAgent),
    },
    opts,
  )
}

export async function getTypingTicket(opts: WechatApiCommonOptions & {
  ilinkUserId: string
  contextToken?: string
}): Promise<string | undefined> {
  const response = await postJson<{
    ret?: number
    errmsg?: string
    typing_ticket?: string
  }>(
    'ilink/bot/getconfig',
    {
      ilink_user_id: opts.ilinkUserId,
      context_token: opts.contextToken ?? undefined,
      base_info: buildBaseInfo(opts.botAgent),
    },
    opts,
  )
  if (response.ret && response.ret !== 0) return undefined
  return response.typing_ticket
}

export async function sendTypingStatus(opts: WechatApiCommonOptions & {
  ilinkUserId: string
  typingTicket: string
  status: 'typing' | 'cancel'
}): Promise<void> {
  await postJson(
    'ilink/bot/sendtyping',
    {
      ilink_user_id: opts.ilinkUserId,
      typing_ticket: opts.typingTicket,
      status: opts.status === 'typing' ? 1 : 2,
      base_info: buildBaseInfo(opts.botAgent),
    },
    opts,
  )
}

export async function notifyStart(opts: WechatApiCommonOptions): Promise<void> {
  await postJson(
    'ilink/bot/msg/notifystart',
    { base_info: buildBaseInfo(opts.botAgent) },
    opts,
  )
}

export async function notifyStop(opts: WechatApiCommonOptions): Promise<void> {
  await postJson(
    'ilink/bot/msg/notifystop',
    { base_info: buildBaseInfo(opts.botAgent) },
    opts,
  )
}
