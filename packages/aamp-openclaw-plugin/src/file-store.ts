import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

export interface Identity {
  email: string
  mailboxToken: string
  smtpPassword: string
}

export interface CachedTaskState {
  terminalTaskIds?: string[]
}

export interface DispatchContextRules {
  [key: string]: string[]
}

export interface PairingCodeState {
  mailbox: string
  pairCode: string
  expiresAt: string
  connectUrl: string
  consumedAt?: string
}

export const DEFAULT_PAIRING_WEB_URL = 'https://meshmail.ai/pair'

export interface PairedSenderPolicy {
  sender: string
  dispatchContextRules: DispatchContextRules
  pairedAt: string
}

export function defaultCredentialsPath(): string {
  return join(homedir(), '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.credentials.json')
}

export function defaultTaskStatePath(): string {
  return join(homedir(), '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.task-state.json')
}

export function defaultPairingPath(): string {
  return join(homedir(), '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.pairing.json')
}

export function defaultSenderPoliciesPath(): string {
  return join(homedir(), '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.sender-policies.json')
}

export function loadCachedIdentity(file?: string): Identity | null {
  const resolved = file ?? defaultCredentialsPath()
  if (!existsSync(resolved)) return null
  try {
    const parsed = JSON.parse(readFileSync(resolved, 'utf-8')) as Partial<Identity>
    if (!parsed.email || !parsed.mailboxToken || !parsed.smtpPassword) return null
    return {
      email: parsed.email,
      mailboxToken: parsed.mailboxToken,
      smtpPassword: parsed.smtpPassword,
    }
  } catch {
    return null
  }
}

export function saveCachedIdentity(identity: Identity, file?: string): void {
  const resolved = file ?? defaultCredentialsPath()
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, JSON.stringify({
    email: identity.email,
    mailboxToken: identity.mailboxToken,
    smtpPassword: identity.smtpPassword,
  }, null, 2), 'utf-8')
}

export function loadTaskState(file?: string): CachedTaskState {
  const resolved = file ?? defaultTaskStatePath()
  if (!existsSync(resolved)) return { terminalTaskIds: [] }
  try {
    const parsed = JSON.parse(readFileSync(resolved, 'utf-8')) as CachedTaskState
    return {
      terminalTaskIds: Array.isArray(parsed.terminalTaskIds) ? parsed.terminalTaskIds.filter(Boolean) : [],
    }
  } catch {
    return { terminalTaskIds: [] }
  }
}

export function saveTaskState(state: CachedTaskState, file?: string): void {
  const resolved = file ?? defaultTaskStatePath()
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, JSON.stringify({
    terminalTaskIds: state.terminalTaskIds ?? [],
  }, null, 2), 'utf-8')
}

export function createPairingCode(params: {
  mailbox: string
  file?: string
  ttlSeconds?: number
}): PairingCodeState {
  const pairCode = randomBytes(6).toString('base64url')
  const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? 300) * 1000).toISOString()
  const connectUrl = `aamp://connect?mailbox=${encodeURIComponent(params.mailbox.toLowerCase())}&pair_code=${encodeURIComponent(pairCode)}`
  const state: PairingCodeState = {
    mailbox: params.mailbox.toLowerCase(),
    pairCode,
    expiresAt,
    connectUrl,
  }
  const resolved = params.file ?? defaultPairingPath()
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, JSON.stringify(state, null, 2), 'utf-8')
  return state
}

export function pairingUrlToWebUrl(connectUrl: string): string {
  const parsed = new URL(connectUrl)
  const url = new URL(DEFAULT_PAIRING_WEB_URL)
  for (const [key, value] of parsed.searchParams) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

export function consumePairingCode(params: {
  mailbox: string
  pairCode: string
  file?: string
}): PairingCodeState | null {
  const resolved = params.file ?? defaultPairingPath()
  if (!existsSync(resolved)) return null
  const state = JSON.parse(readFileSync(resolved, 'utf-8')) as PairingCodeState
  if (state.mailbox.toLowerCase() !== params.mailbox.toLowerCase()) return null
  if (state.pairCode !== params.pairCode) return null
  if (state.consumedAt) return null
  if (new Date(state.expiresAt).getTime() <= Date.now()) return null
  writeFileSync(resolved, JSON.stringify({ ...state, pairCode: '', consumedAt: new Date().toISOString() }, null, 2), 'utf-8')
  return state
}

function isPairedSenderPolicy(value: unknown): value is PairedSenderPolicy {
  if (!value || typeof value !== 'object') return false
  const policy = value as PairedSenderPolicy
  return typeof policy.sender === 'string'
    && typeof policy.dispatchContextRules === 'object'
    && typeof policy.pairedAt === 'string'
}

export function loadPairedSenderPolicies(file?: string): PairedSenderPolicy[] {
  const resolved = file ?? defaultSenderPoliciesPath()
  if (!existsSync(resolved)) return []
  try {
    const data = JSON.parse(readFileSync(resolved, 'utf-8')) as unknown
    return Array.isArray(data) ? data.filter(isPairedSenderPolicy) : []
  } catch {
    return []
  }
}

export function addPairedSenderPolicy(file: string | undefined, policy: PairedSenderPolicy): PairedSenderPolicy[] {
  const resolved = file ?? defaultSenderPoliciesPath()
  const policies = loadPairedSenderPolicies(resolved)
  const normalizedSender = policy.sender.toLowerCase()
  const next = [
    ...policies.filter((item) => item.sender.toLowerCase() !== normalizedSender),
    { ...policy, sender: normalizedSender },
  ]
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, JSON.stringify(next, null, 2), 'utf-8')
  return next
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

export function readBinaryFile(path: string): Buffer {
  return readFileSync(path)
}

export function writeBinaryFile(path: string, content: Uint8Array | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}
