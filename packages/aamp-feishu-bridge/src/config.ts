import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { AampClient } from 'aamp-sdk'
import type { BridgeConfig, BridgeState } from './types.js'

const CONFIG_FILENAME = 'config.json'
const STATE_FILENAME = 'state.json'

export function getBridgeHomeDir(customDir?: string): string {
  return customDir
    ? path.resolve(customDir)
    : path.join(os.homedir(), '.aamp', 'feishu-bridge')
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

export async function loadBridgeConfig(customDir?: string): Promise<BridgeConfig | null> {
  const filePath = getConfigPath(customDir)
  if (!existsSync(filePath)) return null
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw) as BridgeConfig
}

export async function saveBridgeConfig(config: BridgeConfig, customDir?: string): Promise<void> {
  await writeJsonAtomic(getConfigPath(customDir), config)
}

export function createDefaultBridgeState(): BridgeState {
  return {
    version: 1,
    connectivity: {
      feishu: 'disconnected',
      aamp: 'disconnected',
    },
    conversations: {},
    tasks: {},
    dedupMessageIds: {},
  }
}

export async function loadBridgeState(customDir?: string): Promise<BridgeState> {
  const filePath = getStatePath(customDir)
  if (!existsSync(filePath)) {
    return createDefaultBridgeState()
  }
  const raw = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<BridgeState>
  return {
    ...createDefaultBridgeState(),
    ...parsed,
    connectivity: {
      ...createDefaultBridgeState().connectivity,
      ...(parsed.connectivity ?? {}),
    },
    conversations: parsed.conversations ?? {},
    tasks: parsed.tasks ?? {},
    dedupMessageIds: parsed.dedupMessageIds ?? {},
  }
}

export async function saveBridgeState(state: BridgeState, customDir?: string): Promise<void> {
  await writeJsonAtomic(getStatePath(customDir), state)
}

export async function resetBridgeState(customDir?: string): Promise<void> {
  const filePath = getStatePath(customDir)
  if (!existsSync(filePath)) return
  await rm(filePath, { force: true })
}

export interface InitBridgeOptions {
  configDir?: string
  aampHost?: string
  targetAgentEmail?: string
  slug?: string
  appId?: string
  appSecret?: string
  domain?: string
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

function normalizeSlug(rawValue: string): string {
  return rawValue
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32) || 'feishu-bridge'
}

export async function initializeBridgeConfig(options: InitBridgeOptions): Promise<BridgeConfig> {
  const existing = await loadBridgeConfig(options.configDir)

  const aampHost = (options.aampHost ?? existing?.aampHost ?? await prompt('AAMP host', 'https://meshmail.ai')).trim()
  const targetAgentEmail = (options.targetAgentEmail ?? existing?.targetAgentEmail ?? await prompt('Target AAMP agent email')).trim()
  const appId = (options.appId ?? existing?.feishu.appId ?? await prompt('Feishu App ID')).trim()
  const appSecret = (options.appSecret ?? existing?.feishu.appSecret ?? await prompt('Feishu App Secret')).trim()
  const slug = normalizeSlug(options.slug ?? existing?.slug ?? await prompt('Bridge mailbox slug', 'feishu-bridge'))
  const domain = (options.domain ?? existing?.feishu.domain ?? '').trim() || undefined

  if (!targetAgentEmail) throw new Error('Target AAMP agent email is required.')
  if (!appId || !appSecret) throw new Error('Feishu App ID and App Secret are required.')

  const mailbox = existing?.mailbox ?? await AampClient.registerMailbox({
    aampHost,
    slug,
    description: `Feishu bridge for ${targetAgentEmail}`,
  })

  const config: BridgeConfig = {
    version: 1,
    aampHost,
    targetAgentEmail,
    slug,
    feishu: {
      appId,
      appSecret,
      ...(domain ? { domain } : {}),
    },
    mailbox: {
      email: mailbox.email,
      mailboxToken: mailbox.mailboxToken,
      smtpPassword: mailbox.smtpPassword,
      baseUrl: mailbox.baseUrl,
    },
    behavior: {
      streamThrottleMs: existing?.behavior.streamThrottleMs ?? 700,
      streamThrottleChars: existing?.behavior.streamThrottleChars ?? 40,
    },
  }

  await ensureBridgeHomeDir(options.configDir)
  await saveBridgeConfig(config, options.configDir)
  return config
}
