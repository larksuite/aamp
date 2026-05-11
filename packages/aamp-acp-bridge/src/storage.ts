import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { BridgeConfig } from './config.js'

const DEFAULT_CONFIG_FILENAME = 'config.json'
const LEGACY_CONFIG_FILENAME = 'bridge.json'

function getResolvedBridgeHomeDir(): string {
  return join(homedir(), '.aamp', 'acp-bridge')
}

function getResolvedLegacyBridgeHomeDir(): string {
  return join(homedir(), '.acp-bridge')
}

function expandHomePath(pathValue: string): string {
  if (pathValue === '~') return homedir()
  if (pathValue.startsWith('~/')) return join(homedir(), pathValue.slice(2))
  return pathValue
}

function writeFileIfMissing(targetPath: string, content: string | Buffer): void {
  if (existsSync(targetPath)) return
  mkdirSync(dirname(targetPath), { recursive: true })
  writeFileSync(targetPath, content)
}

function normalizeMigratedConfig(config: BridgeConfig): BridgeConfig {
  return {
    ...config,
    agents: config.agents.map((agent) => {
      const next = { ...agent }
      if (!next.credentialsFile || isLegacyDefaultCredentialsPath(next.credentialsFile, agent.name)) {
        next.credentialsFile = getDefaultCredentialsPath(agent.name)
      }
      if (next.senderWhitelist?.length && !next.senderPolicies?.length) {
        next.senderPolicies = next.senderWhitelist.map((sender) => ({ sender }))
      }
      return next
    }),
  }
}

function migrateLegacyDefaultConfigIfNeeded(targetPath: string): void {
  if (existsSync(targetPath)) return

  const legacyPath = resolve(process.cwd(), LEGACY_CONFIG_FILENAME)
  if (!existsSync(legacyPath)) return

  const raw = readFileSync(legacyPath, 'utf8')
  try {
    const parsed = JSON.parse(raw) as BridgeConfig
    writeFileIfMissing(targetPath, `${JSON.stringify(normalizeMigratedConfig(parsed), null, 2)}\n`)
  } catch {
    writeFileIfMissing(targetPath, raw)
  }
}

function migrateLegacyDefaultCredentialsIfNeeded(agentName: string, targetPath: string): void {
  if (existsSync(targetPath)) return
  const legacyPath = getLegacyDefaultCredentialsPath(agentName)
  if (!existsSync(legacyPath)) return
  writeFileIfMissing(targetPath, readFileSync(legacyPath))
}

export function getBridgeHomeDir(): string {
  return getResolvedBridgeHomeDir()
}

export function getDefaultConfigPath(): string {
  return join(getBridgeHomeDir(), DEFAULT_CONFIG_FILENAME)
}

export function getDefaultCredentialsPath(agentName: string): string {
  return join(getBridgeHomeDir(), 'credentials', `${agentName}.json`)
}

export function getLegacyDefaultCredentialsPath(agentName: string): string {
  return join(getResolvedLegacyBridgeHomeDir(), `.aamp-${agentName}.json`)
}

export function isLegacyDefaultCredentialsPath(pathValue: string | undefined, agentName: string): boolean {
  if (!pathValue?.trim()) return false
  return expandHomePath(pathValue.trim()) === getLegacyDefaultCredentialsPath(agentName)
}

export function resolveConfigPath(pathValue?: string): string {
  const raw = pathValue?.trim()
  if (raw) return resolve(expandHomePath(raw))

  const targetPath = getDefaultConfigPath()
  migrateLegacyDefaultConfigIfNeeded(targetPath)
  return targetPath
}

export function resolveCredentialsFile(pathValue: string | undefined, agentName: string): string {
  const raw = pathValue?.trim()
  if (!raw || isLegacyDefaultCredentialsPath(raw, agentName)) {
    const targetPath = getDefaultCredentialsPath(agentName)
    migrateLegacyDefaultCredentialsIfNeeded(agentName, targetPath)
    return targetPath
  }

  return expandHomePath(raw)
}
