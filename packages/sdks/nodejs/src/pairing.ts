import { randomBytes } from 'node:crypto'

export interface DispatchContextRules {
  [key: string]: string[]
}

export interface PairingUrlPayload {
  mailbox: string
  pairCode: string
  dispatchContextRules?: DispatchContextRules
}

export interface CreatePairingCodeOptions {
  mailbox: string
  pairCode?: string
  ttlSeconds?: number
  dispatchContextRules?: DispatchContextRules
}

export interface PairingCode {
  mailbox: string
  pairCode: string
  expiresAt: string
  connectUrl: string
  dispatchContextRules?: DispatchContextRules
  consumedAt?: string
}

export interface ConsumePairingCodeOptions {
  mailbox: string
  pairCode: string
  now?: Date
}

export interface PairedSenderPolicy {
  sender: string
  dispatchContextRules: DispatchContextRules
  pairedAt: string
}

export interface PairableSenderLike {
  from: string
  dispatchContextRules?: DispatchContextRules
}

export const DEFAULT_PAIRING_WEB_URL = 'https://meshmail.ai/pair'

function normalizeMailbox(value: string): string {
  const mailbox = value.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mailbox)) {
    throw new Error(`Invalid AAMP mailbox in pairing URL: ${value}`)
  }
  return mailbox
}

export function normalizeDispatchContextRules(
  rules: DispatchContextRules | undefined,
): DispatchContextRules | undefined {
  if (!rules) return undefined

  const normalized = Object.fromEntries(
    Object.entries(rules)
      .map(([key, values]) => [
        key.trim().toLowerCase(),
        (Array.isArray(values) ? values : [])
          .map((value) => value.trim())
          .filter(Boolean),
      ] as const)
      .filter(([key, values]) => Boolean(key) && values.length > 0),
  )

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

function encodeBase64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decodeDispatchContextRules(value: string): DispatchContextRules | undefined {
  const candidates = [
    () => Buffer.from(value, 'base64url').toString('utf8'),
    () => value,
  ]

  for (const read of candidates) {
    try {
      const parsed = JSON.parse(read()) as DispatchContextRules
      return normalizeDispatchContextRules(parsed)
    } catch {
      // Try the next supported encoding.
    }
  }

  throw new Error('Invalid dispatch_context_rules in pairing URL')
}

export function buildPairingUrl(payload: PairingUrlPayload): string {
  const mailbox = normalizeMailbox(payload.mailbox)
  const pairCode = payload.pairCode.trim()
  if (!pairCode) throw new Error('pairCode cannot be empty')

  const url = new URL('aamp://connect')
  url.searchParams.set('mailbox', mailbox)
  url.searchParams.set('pair_code', pairCode)

  const rules = normalizeDispatchContextRules(payload.dispatchContextRules)
  if (rules) {
    url.searchParams.set('dispatch_context_rules', encodeBase64UrlJson(rules))
  }

  return url.toString()
}

export function buildPairingWebUrl(
  payload: PairingUrlPayload,
  baseUrl = DEFAULT_PAIRING_WEB_URL,
): string {
  const mailbox = normalizeMailbox(payload.mailbox)
  const pairCode = payload.pairCode.trim()
  if (!pairCode) throw new Error('pairCode cannot be empty')

  const url = new URL(baseUrl)
  url.searchParams.set('mailbox', mailbox)
  url.searchParams.set('pair_code', pairCode)

  const rules = normalizeDispatchContextRules(payload.dispatchContextRules)
  if (rules) {
    url.searchParams.set('dispatch_context_rules', encodeBase64UrlJson(rules))
  }

  return url.toString()
}

export function pairingUrlToWebUrl(input: string, baseUrl = DEFAULT_PAIRING_WEB_URL): string {
  return buildPairingWebUrl(parsePairingUrl(input), baseUrl)
}

export function createPairingCode(options: CreatePairingCodeOptions): PairingCode {
  const pairCode = options.pairCode?.trim() || randomBytes(6).toString('base64url')
  const dispatchContextRules = normalizeDispatchContextRules(options.dispatchContextRules)
  return {
    mailbox: normalizeMailbox(options.mailbox),
    pairCode,
    expiresAt: new Date(Date.now() + (options.ttlSeconds ?? 300) * 1000).toISOString(),
    connectUrl: buildPairingUrl({
      mailbox: options.mailbox,
      pairCode,
      ...(dispatchContextRules ? { dispatchContextRules } : {}),
    }),
    ...(dispatchContextRules ? { dispatchContextRules } : {}),
  }
}

export function parsePairingUrl(input: string): PairingUrlPayload {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Invalid pairing URL')
  }

  const isDeepLink = url.protocol === 'aamp:' && url.hostname === 'connect'
  const isWebLink = (url.protocol === 'https:' || url.protocol === 'http:')
    && url.hostname === 'meshmail.ai'
    && url.pathname === '/pair'
  if (!isDeepLink && !isWebLink) {
    throw new Error('Pairing URL must start with aamp://connect or https://meshmail.ai/pair')
  }

  const mailbox = url.searchParams.get('mailbox') ?? ''
  const pairCode = url.searchParams.get('pair_code') ?? ''
  if (!pairCode.trim()) throw new Error('Pairing URL is missing pair_code')

  const rawRules = url.searchParams.get('dispatch_context_rules')
    ?? url.searchParams.get('dispatchContextRules')

  const dispatchContextRules = rawRules
    ? decodeDispatchContextRules(rawRules)
    : undefined

  return {
    mailbox: normalizeMailbox(mailbox),
    pairCode: pairCode.trim(),
    ...(dispatchContextRules ? { dispatchContextRules } : {}),
  }
}

export function isPairingUrl(input: string): boolean {
  try {
    parsePairingUrl(input)
    return true
  } catch {
    return false
  }
}

export function consumePairingCode(
  state: PairingCode,
  options: ConsumePairingCodeOptions,
): PairingCode | null {
  if (state.consumedAt) return null
  if (normalizeMailbox(state.mailbox) !== normalizeMailbox(options.mailbox)) return null
  if (state.pairCode !== options.pairCode.trim()) return null
  if (new Date(state.expiresAt).getTime() <= (options.now ?? new Date()).getTime()) return null
  return {
    ...state,
    pairCode: '',
    connectUrl: '',
    consumedAt: (options.now ?? new Date()).toISOString(),
  }
}

export function createPairedSenderPolicy(
  request: PairableSenderLike,
  pairedAt = new Date(),
): PairedSenderPolicy {
  return {
    sender: normalizeMailbox(request.from),
    dispatchContextRules: normalizeDispatchContextRules(request.dispatchContextRules) ?? {},
    pairedAt: pairedAt.toISOString(),
  }
}

export function upsertPairedSenderPolicy(
  policies: PairedSenderPolicy[],
  policy: PairedSenderPolicy,
): PairedSenderPolicy[] {
  const sender = normalizeMailbox(policy.sender)
  return [
    ...policies.filter((item) => normalizeMailbox(item.sender) !== sender),
    {
      ...policy,
      sender,
      dispatchContextRules: normalizeDispatchContextRules(policy.dispatchContextRules) ?? {},
    },
  ]
}

export function matchPairedSenderPolicy(
  policies: PairedSenderPolicy[],
  sender: string,
  dispatchContext?: Record<string, string>,
): { allowed: boolean; reason?: string } {
  if (policies.length === 0) {
    return { allowed: false, reason: 'no paired sender policies configured' }
  }

  const normalizedSender = normalizeMailbox(sender)
  const policy = policies.find((item) => normalizeMailbox(item.sender) === normalizedSender)
  if (!policy) {
    return { allowed: false, reason: `sender ${sender} is not paired` }
  }

  for (const [key, allowedValues] of Object.entries(policy.dispatchContextRules ?? {})) {
    if (!Array.isArray(allowedValues) || allowedValues.length === 0) continue
    const observed = dispatchContext?.[key]
    if (!observed || !allowedValues.includes(observed)) {
      return { allowed: false, reason: `dispatchContext does not match paired sender policy for ${sender}` }
    }
  }

  return { allowed: true }
}
