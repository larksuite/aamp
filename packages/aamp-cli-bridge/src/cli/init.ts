import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface, emitKeypressEvents } from 'node:readline'
import { AampClient } from 'aamp-sdk'
import type { AgentConfig, BridgeConfig, CliProfileDefinition, SenderPolicy } from '../config.js'
import { BUILTIN_CLI_PROFILES, getBuiltinCliProfileNames, listUserCliProfiles } from '../cli-profiles.js'
import { getDefaultCredentialsPath } from '../storage.js'

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  if ((rl as unknown as { closed?: boolean }).closed) return Promise.resolve('')

  return new Promise((resolve) => {
    const onClose = () => resolve('')
    rl.once('close', onClose)
    try {
      rl.question(question, (answer) => {
        rl.off('close', onClose)
        resolve(answer)
      })
    } catch {
      rl.off('close', onClose)
      resolve('')
    }
  })
}

interface SelectItem<T extends string> {
  value: T
  label: string
  description?: string
  selected?: boolean
}

async function multiSelect<T extends string>(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  items: Array<SelectItem<T>>,
): Promise<T[]> {
  if (items.length === 0) return []
  const defaultSelected = new Set(items.filter((item) => item.selected).map((item) => item.value))

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const input = await ask(
      rl,
      `${prompt} (comma-separated, empty for current selection, "all" for all, "none" for none): `,
    )
    const normalized = input.trim().toLowerCase()
    if (!normalized) return items.filter((item) => defaultSelected.has(item.value)).map((item) => item.value)
    if (normalized === 'all') return items.map((item) => item.value)
    if (normalized === 'none') return []

    const requested = new Set(normalized.split(',').map((item) => item.trim()).filter(Boolean))
    return items
      .filter((item) => requested.has(item.value.toLowerCase()))
      .map((item) => item.value)
  }

  return await new Promise<T[]>((resolve, reject) => {
    let cursor = 0
    const selected = new Set<T>(defaultSelected)
    let renderedLines = 0

    const render = () => {
      if (renderedLines > 0) {
        process.stdout.write(`\x1B[${renderedLines}A\x1B[0J`)
      }

      const lines = [
        `${prompt} (↑/↓ to move, Space to select, Enter to confirm)`,
        ...items.map((item, index) => {
          const pointer = index === cursor ? '>' : ' '
          const checkbox = selected.has(item.value) ? '[x]' : '[ ]'
          const details = item.description ? ` ${item.description}` : ''
          return `${pointer} ${checkbox} ${item.label}${details}`
        }),
      ]
      process.stdout.write(`${lines.join('\n')}\n`)
      renderedLines = lines.length
    }

    const wasRawMode = process.stdin.isRaw

    const cleanup = () => {
      process.stdin.off('keypress', onKeypress)
      process.stdin.setRawMode(wasRawMode)
      rl.resume()
      process.stdout.write('\n')
    }

    const onKeypress = (_str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        reject(new Error('Selection cancelled'))
        return
      }

      switch (key.name) {
        case 'up':
        case 'k':
          cursor = (cursor - 1 + items.length) % items.length
          render()
          break
        case 'down':
        case 'j':
          cursor = (cursor + 1) % items.length
          render()
          break
        case 'space': {
          const value = items[cursor].value
          if (selected.has(value)) selected.delete(value)
          else selected.add(value)
          render()
          break
        }
        case 'return':
        case 'enter':
          cleanup()
          resolve(items.filter((item) => selected.has(item.value)).map((item) => item.value))
          break
        default:
          break
      }
    }

    rl.pause()
    emitKeypressEvents(process.stdin)
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('keypress', onKeypress)
    render()
  })
}

function parseEmailList(input: string): string[] {
  return input
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function parseDispatchContextRules(raw: string): Record<string, string[]> | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  const rules: Record<string, string[]> = {}
  for (const part of trimmed.split(';')) {
    const segment = part.trim()
    if (!segment) continue

    const eqIdx = segment.indexOf('=')
    if (eqIdx <= 0) continue

    const key = segment.slice(0, eqIdx).trim().toLowerCase()
    if (!/^[a-z0-9_-]+$/.test(key)) continue

    const values = segment
      .slice(eqIdx + 1)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)

    if (values.length > 0) {
      rules[key] = values
    }
  }

  return Object.keys(rules).length > 0 ? rules : undefined
}

function extractSenderPolicies(rawAgent: Record<string, unknown> | undefined): SenderPolicy[] | undefined {
  if (!rawAgent) return undefined

  if (Array.isArray(rawAgent.senderPolicies) && rawAgent.senderPolicies.length > 0) {
    return rawAgent.senderPolicies as SenderPolicy[]
  }

  if (Array.isArray(rawAgent.senderWhitelist) && rawAgent.senderWhitelist.length > 0) {
    return rawAgent.senderWhitelist
      .filter((sender): sender is string => typeof sender === 'string' && sender.trim().length > 0)
      .map((sender) => ({ sender: sender.trim().toLowerCase() }))
  }

  return undefined
}

function loadPreviousSenderPolicies(configPath: string): Map<string, SenderPolicy[]> {
  if (!existsSync(configPath)) return new Map()

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as { agents?: unknown }
    if (!Array.isArray(raw.agents)) return new Map()

    const entries = raw.agents.flatMap((agent): Array<[string, SenderPolicy[]]> => {
      if (!agent || typeof agent !== 'object') return []
      const record = agent as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name : ''
      if (!name) return []

      const policies = extractSenderPolicies(record)
      return policies?.length ? [[name, policies]] : []
    })

    return new Map(entries)
  } catch {
    return new Map()
  }
}

function loadPreviousConfig(configPath: string): BridgeConfig | undefined {
  if (!existsSync(configPath)) return undefined

  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Partial<BridgeConfig>
    if (!raw || !Array.isArray(raw.agents)) return undefined

    return {
      aampHost: typeof raw.aampHost === 'string' ? raw.aampHost : 'https://meshmail.ai',
      rejectUnauthorized: raw.rejectUnauthorized === true,
      ...(raw.profiles ? { profiles: raw.profiles } : {}),
      agents: raw.agents,
    } as BridgeConfig
  } catch {
    return undefined
  }
}

async function promptSenderPolicies(
  rl: ReturnType<typeof createInterface>,
  name: string,
  previousPolicies: SenderPolicy[] | undefined,
  allPreviousPolicies: Map<string, SenderPolicy[]>,
): Promise<SenderPolicy[] | undefined> {
  if (previousPolicies?.length) {
    const reuseAnswer = await ask(
      rl,
      `? Reuse existing sender policies for ${name}? (Y/n): `,
    )
    if (reuseAnswer.trim().toLowerCase() !== 'n') {
      return previousPolicies
    }
  }

  const reusablePolicies = [...allPreviousPolicies.entries()]
    .filter(([agentName, policies]) => agentName !== name && policies.length > 0)
  if (reusablePolicies.length > 0) {
    console.log(`? Existing sender policies available:`)
    reusablePolicies.forEach(([agentName, policies], index) => {
      const senders = policies.map((policy) => policy.sender).join(', ')
      console.log(`  ${index + 1}. ${agentName} (${senders})`)
    })
    const reuseOtherAnswer = await ask(
      rl,
      `? Reuse sender policies from another agent for ${name}? (number, empty for no): `,
    )
    const selectedIndex = Number(reuseOtherAnswer.trim())
    if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= reusablePolicies.length) {
      return reusablePolicies[selectedIndex - 1][1]
    }
  }

  const policyAnswer = await ask(rl, `? Restrict ${name} with sender policies? (y/N): `)
  if (policyAnswer.trim().toLowerCase() !== 'y') return undefined

  const sendersInput = await ask(rl, `? Allowed sender emails for ${name} (comma-separated): `)
  const senders = parseEmailList(sendersInput)
  if (senders.length === 0) {
    console.log(`  Warning: no valid sender entries provided; ${name} will accept all senders.`)
    return undefined
  }

  const senderPolicies: SenderPolicy[] = []
  for (const sender of senders) {
    const rulesInput = await ask(
      rl,
      `? Dispatch context rules for ${sender} (optional, format: project_key=proj1,proj2; user_key=alice): `,
    )
    const dispatchContextRules = parseDispatchContextRules(rulesInput)
    senderPolicies.push({
      sender,
      ...(dispatchContextRules ? { dispatchContextRules } : {}),
    })
  }

  return senderPolicies
}

function renderCommandForDetection(command: string, profileName: string): string | null {
  const rendered = command.replace(/\{\{\s*agentName\s*\}\}/g, profileName)
  if (/\{\{/.test(rendered)) return null
  if (/\s/.test(rendered.trim())) return null
  return rendered.trim() || null
}

function detectCommand(command: string): string | null {
  try {
    execFileSync('which', [command], { stdio: 'pipe' })
    try {
      return execFileSync(command, ['--version'], { stdio: 'pipe' }).toString().trim().split('\n')[0] || 'installed'
    } catch {
      return 'installed'
    }
  } catch {
    return null
  }
}

interface ProfileCandidate {
  name: string
  cliProfile: AgentConfig['cliProfile']
  profile?: CliProfileDefinition
  source: 'built-in' | 'user' | 'config' | 'configured'
  command?: string
  version?: string
  existingAgent?: AgentConfig
}

function profileLabel(profileRef: AgentConfig['cliProfile']): string {
  if (typeof profileRef === 'string') return profileRef
  return profileRef.name ?? 'inline'
}

function resolveProfileForExistingAgent(
  agent: AgentConfig,
  customProfiles: BridgeConfig['profiles'] | undefined,
): CliProfileDefinition | undefined {
  if (typeof agent.cliProfile !== 'string') return agent.cliProfile
  return customProfiles?.[agent.cliProfile]
    ?? BUILTIN_CLI_PROFILES[agent.cliProfile]
    ?? listUserCliProfiles().find((item) => item.name === agent.cliProfile)?.profile
}

function collectProfileCandidates(previousConfig?: BridgeConfig): ProfileCandidate[] {
  const profiles = new Map<string, ProfileCandidate>()

  for (const name of getBuiltinCliProfileNames()) {
    profiles.set(name, {
      name,
      cliProfile: name,
      profile: BUILTIN_CLI_PROFILES[name],
      source: 'built-in',
    })
  }

  for (const [name, profile] of Object.entries(previousConfig?.profiles ?? {})) {
    profiles.set(name, {
      name,
      cliProfile: name,
      profile,
      source: 'config',
    })
  }

  for (const { name, profile } of listUserCliProfiles()) {
    profiles.set(name, {
      name,
      cliProfile: name,
      profile,
      source: 'user',
    })
  }

  const existingAgents = new Map((previousConfig?.agents ?? []).map((agent) => [agent.name, agent]))
  for (const agent of existingAgents.values()) {
    const existing = profiles.get(agent.name)
    const profile = resolveProfileForExistingAgent(agent, previousConfig?.profiles)
    if (existing) {
      profiles.set(agent.name, {
        ...existing,
        existingAgent: agent,
        cliProfile: agent.cliProfile,
        profile: profile ?? existing.profile,
      })
      continue
    }

    profiles.set(agent.name, {
      name: agent.name,
      cliProfile: agent.cliProfile,
      ...(profile ? { profile } : {}),
      source: 'configured',
      existingAgent: agent,
    })
  }

  return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function detectProfileCandidate(candidate: ProfileCandidate): ProfileCandidate {
  const command = candidate.profile
    ? renderCommandForDetection(candidate.profile.command, candidate.name)
    : null
  if (!command) return candidate
  const version = detectCommand(command)
  return {
    ...candidate,
    command,
    ...(version ? { version } : {}),
  }
}

function formatProfileScanLine(candidate: ProfileCandidate): string {
  const label = `${candidate.name} [${candidate.source}]`
  if (candidate.version) {
    return `  + ${label.padEnd(24)} ${candidate.command} (${candidate.version})`
  }
  if (candidate.existingAgent) {
    const profile = profileLabel(candidate.cliProfile)
    return `  * ${label.padEnd(24)} ${profile} (already configured, not detected)`
  }

  const command = candidate.command ?? candidate.profile?.command ?? profileLabel(candidate.cliProfile)
  return `  - ${label.padEnd(24)} ${command} (not detected)`
}

function renderScanProgress(index: number, total: number, candidate: ProfileCandidate): void {
  const label = `${candidate.name} [${candidate.source}]`
  process.stdout.write(`  scanning ${index}/${total}: ${label}...\r`)
}

function clearScanProgress(): void {
  process.stdout.write('\x1B[2K\r')
}

export async function runInit(configPath: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const previousConfig = loadPreviousConfig(configPath)
  const previousAgents = new Map((previousConfig?.agents ?? []).map((agent) => [agent.name, agent]))

  console.log('\nAAMP CLI Bridge Setup\n')

  const defaultAampHost = previousConfig?.aampHost ?? 'https://meshmail.ai'
  const aampHostInput = (await ask(rl, `? AAMP Service URL (default: ${defaultAampHost}): `)).trim()
  const aampHost = aampHostInput || defaultAampHost

  try {
    const res = await fetch(`${aampHost}/health`)
    if (res.ok) {
      const data = await res.json() as { service: string }
      console.log(`  Connected (${data.service})\n`)
    } else {
      console.log(`  Warning: Server responded with ${res.status}\n`)
    }
  } catch {
    console.log(`  Warning: Could not reach ${aampHost} -- continuing anyway\n`)
  }

  console.log('? Scanning CLI profiles...')
  const detected: ProfileCandidate[] = []
  const candidates = collectProfileCandidates(previousConfig)
  for (const [index, candidate] of candidates.entries()) {
    renderScanProgress(index + 1, candidates.length, candidate)
    const scanned = detectProfileCandidate(candidate)
    clearScanProgress()
    console.log(formatProfileScanLine(scanned))
    if (scanned.version || scanned.existingAgent) detected.push(scanned)
  }
  console.log()

  const selected = await multiSelect(
    rl,
    '? Select CLI profiles to bridge',
    detected.map((candidate) => ({
      value: candidate.name,
      label: `${candidate.name} [${candidate.source}]`,
      description: candidate.command
        ? `${candidate.command} (${candidate.version ?? 'detected'})`
        : `${profileLabel(candidate.cliProfile)}${candidate.existingAgent ? ' (already configured)' : ''}`,
      selected: Boolean(candidate.existingAgent),
    })),
  )

  const selectedSet = new Set(selected)
  const agents: AgentConfig[] = []
  const previousSenderPolicies = loadPreviousSenderPolicies(configPath)
  for (const candidate of detected.filter((item) => selectedSet.has(item.name))) {
    const { name } = candidate
    const previousAgent = previousAgents.get(name)

    const credFile = previousAgent?.credentialsFile ?? getDefaultCredentialsPath(name)
    const senderPolicies = await promptSenderPolicies(
      rl,
      name,
      previousSenderPolicies.get(name),
      previousSenderPolicies,
    )

    const baseAgent: AgentConfig = {
      ...(previousAgent ?? {
        name,
        cliProfile: candidate.cliProfile,
        slug: `${name}-cli-bridge`,
        description: `${name} via CLI bridge`,
      }),
      name,
      cliProfile: previousAgent?.cliProfile ?? candidate.cliProfile,
      slug: previousAgent?.slug ?? `${name}-cli-bridge`,
      credentialsFile: credFile,
      senderPolicies,
    }
    delete baseAgent.senderWhitelist

    if (existsSync(credFile)) {
      console.log(`  + ${name} -> using existing credentials (${credFile})`)
      agents.push(baseAgent)
      continue
    }

    try {
      const creds = await AampClient.registerMailbox({
        aampHost,
        slug: `${name}-cli-bridge`,
        description: `${name} via CLI bridge`,
      })

      mkdirSync(dirname(credFile), { recursive: true })
      writeFileSync(credFile, JSON.stringify({
        email: creds.email,
        mailboxToken: creds.mailboxToken,
        smtpPassword: creds.smtpPassword,
      }, null, 2))

      console.log(`  + ${name} -> ${creds.email}`)
      agents.push({
        ...baseAgent,
        credentialsFile: credFile,
      })
    } catch (err) {
      console.log(`  x ${name} -> registration failed: ${(err as Error).message}`)
    }
  }

  if (agents.length === 0) {
    console.log('No agents selected. Use profile-maker for custom CLI agents, then edit the config.')
    rl.close()
    return
  }

  const config: BridgeConfig = {
    ...(previousConfig ?? {}),
    aampHost,
    rejectUnauthorized: previousConfig?.rejectUnauthorized ?? false,
    agents,
  }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`\nConfig written to ${configPath}`)
  console.log(`  Run: npx aamp-cli-bridge start\n`)

  rl.close()
}
