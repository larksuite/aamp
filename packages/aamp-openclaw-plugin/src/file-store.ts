import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export interface Identity {
  email: string
  jmapToken: string
  smtpPassword: string
}

export function defaultCredentialsPath(): string {
  return join(homedir(), '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.credentials.json')
}

export function loadCachedIdentity(file?: string): Identity | null {
  const resolved = file ?? defaultCredentialsPath()
  if (!existsSync(resolved)) return null
  try {
    const parsed = JSON.parse(readFileSync(resolved, 'utf-8')) as Partial<Identity>
    if (!parsed.email || !parsed.jmapToken || !parsed.smtpPassword) return null
    return parsed as Identity
  } catch {
    return null
  }
}

export function saveCachedIdentity(identity: Identity, file?: string): void {
  const resolved = file ?? defaultCredentialsPath()
  mkdirSync(dirname(resolved), { recursive: true })
  writeFileSync(resolved, JSON.stringify(identity, null, 2), 'utf-8')
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
