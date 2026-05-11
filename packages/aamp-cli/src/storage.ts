import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LEGACY_SUBDIRS = ['profiles', 'nodes', 'node-state'] as const

function getResolvedCliHomeDir(): string {
  return path.join(os.homedir(), '.aamp', 'cli')
}

function getResolvedLegacyCliHomeDir(): string {
  return path.join(os.homedir(), '.aamp-cli')
}

function copyRecursiveIfMissing(sourcePath: string, targetPath: string): void {
  const sourceStats = statSync(sourcePath)
  if (sourceStats.isDirectory()) {
    mkdirSync(targetPath, { recursive: true })
    for (const entry of readdirSync(sourcePath)) {
      copyRecursiveIfMissing(path.join(sourcePath, entry), path.join(targetPath, entry))
    }
    return
  }

  if (existsSync(targetPath)) return
  mkdirSync(path.dirname(targetPath), { recursive: true })
  copyFileSync(sourcePath, targetPath)
}

function ensureLegacyStorageMigrated(): void {
  const legacyHomeDir = getResolvedLegacyCliHomeDir()
  if (!existsSync(legacyHomeDir)) return
  const cliHomeDir = getResolvedCliHomeDir()

  for (const subdir of LEGACY_SUBDIRS) {
    const sourcePath = path.join(legacyHomeDir, subdir)
    if (!existsSync(sourcePath)) continue
    copyRecursiveIfMissing(sourcePath, path.join(cliHomeDir, subdir))
  }
}

export function getCliHomeDir(): string {
  ensureLegacyStorageMigrated()
  return getResolvedCliHomeDir()
}

export function getProfilesDir(): string {
  return path.join(getCliHomeDir(), 'profiles')
}

export function getNodeRootDir(): string {
  return path.join(getCliHomeDir(), 'nodes')
}

export function getNodeStateRootDir(): string {
  return path.join(getCliHomeDir(), 'node-state')
}
