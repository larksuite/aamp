import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface Identity {
  email: string
  mailboxToken: string
  smtpPassword: string
}

export interface CachedTaskState {
  terminalTaskIds?: string[]
}

export function defaultCredentialsPath(): string {
  return join(homedir(), '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.credentials.json')
}

export function defaultTaskStatePath(): string {
  return join(homedir(), '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.task-state.json')
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
