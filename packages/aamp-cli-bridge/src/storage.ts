import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { BridgeConfig } from './config.js'

const DEFAULT_CONFIG_FILENAME = 'config.json'

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

function getResolvedBridgeHomeDir(): string {
  return join(homedir(), '.aamp', 'cli-bridge')
}

function migrateDraftCliBridgeConfigIfNeeded(targetPath: string): void {
  if (existsSync(targetPath)) return

  const draftPath = resolve(process.cwd(), 'cli-bridge.json')
  if (!existsSync(draftPath)) return

  const raw = readFileSync(draftPath, 'utf8')
  try {
    const parsed = JSON.parse(raw) as BridgeConfig
    writeFileIfMissing(targetPath, `${JSON.stringify(parsed, null, 2)}\n`)
  } catch {
    writeFileIfMissing(targetPath, raw)
  }
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

export function getDefaultProfilesDir(): string {
  return join(getBridgeHomeDir(), 'profiles')
}

export function getDefaultProfilePath(profileName: string): string {
  return join(getDefaultProfilesDir(), `${profileName}.json`)
}

export function resolveConfigPath(pathValue?: string): string {
  const raw = pathValue?.trim()
  if (raw) return resolve(expandHomePath(raw))

  const targetPath = getDefaultConfigPath()
  migrateDraftCliBridgeConfigIfNeeded(targetPath)
  return targetPath
}

export function resolveCredentialsFile(pathValue: string | undefined, agentName: string): string {
  const raw = pathValue?.trim()
  if (!raw) return getDefaultCredentialsPath(agentName)
  return expandHomePath(raw)
}
