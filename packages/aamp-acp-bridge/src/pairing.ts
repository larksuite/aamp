import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getBridgeHomeDir } from './storage.js'

export interface DispatchContextRules {
  [key: string]: string[]
}

export interface SenderPolicy {
  sender: string
  dispatchContextRules: DispatchContextRules
  pairedAt?: string
}

export interface PairingCodeState {
  mailbox: string
  pairCode: string
  expiresAt: string
  connectUrl: string
  consumedAt?: string
}

function expandHome(pathValue: string): string {
  if (pathValue === '~') return homedir()
  if (pathValue.startsWith('~/')) return join(homedir(), pathValue.slice(2))
  return pathValue
}

export function defaultPairingFile(name: string): string {
  return join(getBridgeHomeDir(), 'pairing', `${name}.json`)
}

export function defaultSenderPoliciesFile(name: string): string {
  return join(getBridgeHomeDir(), 'sender-policies', `${name}.json`)
}

export function resolvePairingFile(pathValue: string | undefined, name: string): string {
  return expandHome(pathValue?.trim() || defaultPairingFile(name))
}

export function resolveSenderPoliciesFile(pathValue: string | undefined, name: string): string {
  return expandHome(pathValue?.trim() || defaultSenderPoliciesFile(name))
}

export function createPairingCode(params: {
  mailbox: string
  file: string
  ttlSeconds?: number
}): PairingCodeState {
  const pairCode = randomBytes(6).toString('base64url')
  const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? 300) * 1000).toISOString()
  const connectUrl = `aamp://connect?mailbox=${encodeURIComponent(params.mailbox)}&pair_code=${encodeURIComponent(pairCode)}`
  const state: PairingCodeState = {
    mailbox: params.mailbox,
    pairCode,
    expiresAt,
    connectUrl,
  }
  mkdirSync(dirname(params.file), { recursive: true })
  writeFileSync(params.file, JSON.stringify(state, null, 2))
  return state
}

export function consumePairingCode(params: {
  file: string
  mailbox: string
  pairCode: string
}): PairingCodeState | null {
  const state = validatePairingCode(params)
  if (!state) return null
  writeFileSync(params.file, JSON.stringify({ ...state, pairCode: '', consumedAt: new Date().toISOString() }, null, 2))
  return state
}

export function validatePairingCode(params: {
  file: string
  mailbox: string
  pairCode: string
}): PairingCodeState | null {
  if (!existsSync(params.file)) return null
  const state = JSON.parse(readFileSync(params.file, 'utf-8')) as PairingCodeState
  if (state.mailbox.toLowerCase() !== params.mailbox.toLowerCase()) return null
  if (state.pairCode !== params.pairCode) return null
  if (state.consumedAt) return null
  if (new Date(state.expiresAt).getTime() <= Date.now()) return null
  return state
}

export function loadSenderPolicies(file: string): SenderPolicy[] {
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    return Array.isArray(data)
      ? data.map(normalizeSenderPolicy).filter((policy): policy is SenderPolicy => Boolean(policy))
      : []
  } catch {
    return []
  }
}

export function addSenderPolicy(file: string, policy: SenderPolicy): SenderPolicy[] {
  const policies = loadSenderPolicies(file)
  const normalizedSender = policy.sender.toLowerCase()
  const next = [
    ...policies.filter((item) => item.sender.toLowerCase() !== normalizedSender),
    { ...policy, sender: normalizedSender },
  ]
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2))
  return next
}

function normalizeSenderPolicy(value: unknown): SenderPolicy | null {
  if (!value || typeof value !== 'object') return null
  const policy = value as SenderPolicy
  if (typeof policy.sender !== 'string') return null
  const sender = policy.sender.trim().toLowerCase()
  if (!sender) return null

  const dispatchContextRules = normalizeDispatchContextRules(policy.dispatchContextRules)
  return {
    sender,
    dispatchContextRules: dispatchContextRules ?? {},
    ...(typeof policy.pairedAt === 'string' && policy.pairedAt.trim()
      ? { pairedAt: policy.pairedAt.trim() }
      : {}),
  }
}

function normalizeDispatchContextRules(rules: unknown): DispatchContextRules | undefined {
  if (!rules || typeof rules !== 'object') return undefined

  const normalized = Object.fromEntries(
    Object.entries(rules as Record<string, unknown>)
      .map(([key, values]) => [
        key.trim().toLowerCase(),
        (Array.isArray(values) ? values : [])
          .filter((value): value is string => typeof value === 'string')
          .map((value) => value.trim())
          .filter(Boolean),
      ] as const)
      .filter(([key, values]) => Boolean(key) && values.length > 0),
  )

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

export function rulesMatch(
  rules: DispatchContextRules,
  dispatchContext?: Record<string, string>,
): boolean {
  for (const [key, allowedValues] of Object.entries(rules)) {
    if (!Array.isArray(allowedValues) || allowedValues.length === 0) continue
    const observed = dispatchContext?.[key]
    if (!observed || !allowedValues.includes(observed)) return false
  }
  return true
}
