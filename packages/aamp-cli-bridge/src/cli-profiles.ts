import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { CliProfileDefinition } from './config.js'
import { cliProfileDefinitionSchema } from './config.js'
import { getDefaultProfilePath, getDefaultProfilesDir } from './storage.js'

export const BUILTIN_CLI_PROFILES: Record<string, CliProfileDefinition> = {
  claude: {
    name: 'claude',
    description: 'Claude Code print mode.',
    command: 'claude',
    args: ['-p', '{{prompt}}'],
    timeoutMs: 1_800_000,
  },
  codex: {
    name: 'codex',
    description: 'Codex CLI non-interactive execution.',
    command: 'codex',
    args: ['exec', '--skip-git-repo-check', '{{prompt}}'],
    timeoutMs: 1_800_000,
  },
  gemini: {
    name: 'gemini',
    description: 'Gemini CLI prompt mode.',
    command: 'gemini',
    args: ['--prompt', '{{prompt}}'],
    timeoutMs: 1_800_000,
  },
  codem: {
    name: 'codem',
    description: 'Codem SSE mode.',
    command: 'codem',
    args: ['-p', '{{prompt}}', '--sse'],
    timeoutMs: 1_800_000,
    stream: {
      format: 'sse',
    },
  },
}

export function getBuiltinCliProfileNames(): string[] {
  return Object.keys(BUILTIN_CLI_PROFILES).sort()
}

export function getUserCliProfileNames(): string[] {
  const profilesDir = getDefaultProfilesDir()
  if (!existsSync(profilesDir)) return []

  return readdirSync(profilesDir)
    .filter((item) => item.endsWith('.json'))
    .map((item) => item.replace(/\.json$/, ''))
    .sort()
}

export function listUserCliProfiles(): Array<{ name: string; profile: CliProfileDefinition }> {
  return getUserCliProfileNames().flatMap((name) => {
    try {
      const profile = loadUserCliProfile(name)
      return profile ? [{ name, profile }] : []
    } catch {
      return []
    }
  })
}

export function loadUserCliProfile(profileName: string): CliProfileDefinition | undefined {
  const profilePath = getDefaultProfilePath(profileName)
  if (!existsSync(profilePath)) return undefined

  const parsed = JSON.parse(readFileSync(profilePath, 'utf-8'))
  return cliProfileDefinitionSchema.parse({
    name: profileName,
    ...parsed,
  })
}

export function resolveCliProfile(
  profileRef: string | CliProfileDefinition,
  customProfiles: Record<string, CliProfileDefinition> | undefined,
): CliProfileDefinition {
  if (typeof profileRef !== 'string') {
    return cliProfileDefinitionSchema.parse(profileRef)
  }

  const profileName = profileRef.trim()
  const customProfile = customProfiles?.[profileName]
  if (customProfile) {
    return cliProfileDefinitionSchema.parse({
      name: profileName,
      ...customProfile,
    })
  }

  const userProfile = loadUserCliProfile(profileName)
  if (userProfile) return userProfile

  const builtinProfile = BUILTIN_CLI_PROFILES[profileName]
  if (builtinProfile) return builtinProfile

  throw new Error(
    `Unknown CLI profile "${profileName}". Run 'aamp-cli-bridge profile-list' or create one with 'aamp-cli-bridge profile-maker'. Profiles directory: ${getDefaultProfilesDir()}`,
  )
}
