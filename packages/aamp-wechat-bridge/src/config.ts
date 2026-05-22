import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { randomUUID } from 'node:crypto'
import { stdin as input, stdout as output } from 'node:process'
import { AampClient, isPairingUrl, parsePairingUrl } from 'aamp-sdk'
import type { BridgeConfig, BridgeMailboxIdentity, BridgeState } from './types.js'

const CONFIG_FILENAME = 'config.json'
const STATE_FILENAME = 'state.json'
const DEFAULT_BRIDGE_SLUG = 'wechat-bridge'
const DEFAULT_BOT_AGENT = 'AAMP-WeChat-Bridge/0.1.0'

export interface InitBridgeOptions {
  configDir?: string
  aampHost?: string
  targetAgentEmail?: string
  pairingUrl?: string
  slug?: string
  summary?: string
  botAgent?: string
  dispatchTimeoutMs?: number
  pollTimeoutMs?: number
}

export function getBridgeHomeDir(customDir?: string): string {
  return customDir
    ? path.resolve(customDir)
    : path.join(os.homedir(), '.aamp', 'wechat-bridge')
}

export function getConfigPath(customDir?: string): string {
  return path.join(getBridgeHomeDir(customDir), CONFIG_FILENAME)
}

export function getStatePath(customDir?: string): string {
  return path.join(getBridgeHomeDir(customDir), STATE_FILENAME)
}

export async function ensureBridgeHomeDir(customDir?: string): Promise<string> {
  const dir = getBridgeHomeDir(customDir)
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const parentDir = path.dirname(filePath)
  await mkdir(parentDir, { recursive: true })
  const tempPath = path.join(parentDir, `.${path.basename(filePath)}.${randomUUID()}.tmp`)
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tempPath, filePath)
}

export function createDefaultBridgeState(): BridgeState {
  return {
    version: 1,
    processedMessageIds: [],
    contextTokens: {},
    conversations: {},
    tasks: {},
  }
}

export async function loadBridgeConfig(customDir?: string): Promise<BridgeConfig | null> {
  const filePath = getConfigPath(customDir)
  if (!existsSync(filePath)) return null
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw) as BridgeConfig
}

export async function saveBridgeConfig(config: BridgeConfig, customDir?: string): Promise<void> {
  await writeJsonAtomic(getConfigPath(customDir), config)
}

export async function loadBridgeState(customDir?: string): Promise<BridgeState> {
  const filePath = getStatePath(customDir)
  if (!existsSync(filePath)) return createDefaultBridgeState()
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<BridgeState>
  return {
    ...createDefaultBridgeState(),
    ...parsed,
    processedMessageIds: Array.isArray(parsed.processedMessageIds) ? parsed.processedMessageIds : [],
    contextTokens: parsed.contextTokens ?? {},
    conversations: parsed.conversations ?? {},
    tasks: parsed.tasks ?? {},
  }
}

export async function saveBridgeState(state: BridgeState, customDir?: string): Promise<void> {
  await writeJsonAtomic(getStatePath(customDir), state)
}

function normalizeBaseUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url.replace(/\/$/, '')
  return `https://${url.replace(/\/$/, '')}`
}

function normalizeSlug(rawValue: string): string {
  return rawValue
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || DEFAULT_BRIDGE_SLUG
}

async function prompt(question: string, defaultValue = ''): Promise<string> {
  const rl = readline.createInterface({ input, output })
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : ''
    const answer = await rl.question(`${question}${suffix}: `)
    return answer.trim() || defaultValue
  } finally {
    rl.close()
  }
}

function toMailboxIdentity(mailbox: BridgeMailboxIdentity | Awaited<ReturnType<typeof AampClient.registerMailbox>>): BridgeMailboxIdentity {
  return {
    email: mailbox.email,
    mailboxToken: mailbox.mailboxToken,
    smtpPassword: mailbox.smtpPassword,
    baseUrl: mailbox.baseUrl,
  }
}

export async function initializeBridgeConfig(options: InitBridgeOptions): Promise<BridgeConfig> {
  const existing = await loadBridgeConfig(options.configDir)

  const aampHost = (options.aampHost ?? existing?.aampHost ?? await prompt('AAMP host', 'https://meshmail.ai')).trim()
  const targetInput = (options.pairingUrl ?? options.targetAgentEmail ?? existing?.targetAgentEmail ?? await prompt('Target AAMP agent email or pairing URL')).trim()
  const pairing = isPairingUrl(targetInput)
    ? parsePairingUrl(targetInput)
    : undefined
  const targetAgentEmail = pairing?.mailbox ?? targetInput
  const slug = normalizeSlug(options.slug ?? existing?.slug ?? DEFAULT_BRIDGE_SLUG)
  const summary = (options.summary ?? existing?.summary ?? '').trim() || undefined
  const botAgent = (options.botAgent ?? existing?.wechat.botAgent ?? DEFAULT_BOT_AGENT).trim()
  const dispatchTimeoutMs = Math.max(1000, Math.trunc(options.dispatchTimeoutMs ?? existing?.behavior.dispatchTimeoutMs ?? 180000))
  const pollTimeoutMs = Math.max(5000, Math.trunc(options.pollTimeoutMs ?? existing?.behavior.pollTimeoutMs ?? 35000))

  if (!aampHost) throw new Error('AAMP host is required.')
  if (!targetAgentEmail) throw new Error('Target AAMP agent email is required.')

  const mailbox = existing?.mailbox ?? toMailboxIdentity(await AampClient.registerMailbox({
    aampHost,
    slug,
    description: `WeChat bridge for ${targetAgentEmail}`,
  }))

  const config: BridgeConfig = {
    version: 1,
    aampHost: normalizeBaseUrl(aampHost),
    targetAgentEmail,
    slug,
    ...(summary ? { summary } : {}),
    mailbox: toMailboxIdentity(mailbox),
    wechat: {
      apiBaseUrl: existing?.wechat.apiBaseUrl ?? 'https://ilinkai.weixin.qq.com',
      botType: existing?.wechat.botType ?? '3',
      botAgent: botAgent || DEFAULT_BOT_AGENT,
    },
    behavior: {
      dispatchTimeoutMs,
      pollTimeoutMs,
    },
  }

  await ensureBridgeHomeDir(options.configDir)
  await saveBridgeConfig(config, options.configDir)
  if (pairing) {
    const client = AampClient.fromMailboxIdentity({
      email: config.mailbox.email,
      smtpPassword: config.mailbox.smtpPassword,
      baseUrl: config.mailbox.baseUrl,
    })
    await client.sendPairRequest({
      to: pairing.mailbox,
      pairCode: pairing.pairCode,
      dispatchContextRules: pairing.dispatchContextRules ?? { source: ['wechat'] },
    })
  }
  return config
}
