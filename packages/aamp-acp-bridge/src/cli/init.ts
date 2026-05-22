import { createInterface, emitKeypressEvents } from 'node:readline'
import { writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { dirname } from 'node:path'
import { AampClient } from 'aamp-sdk'
import * as qrcode from 'qrcode-terminal'
import type { AgentConfig, BridgeConfig, SenderPolicy } from '../config.js'
import { getDefaultCredentialsPath } from '../storage.js'
import {
  createPairingCode,
  defaultPairingFile,
  defaultSenderPoliciesFile,
  pairingUrlToWebUrl,
} from '../pairing.js'

const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
]

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

type ConnectionSetupMethod = 'pairing-code' | 'manual-sender-policy' | 'reuse-sender-policy' | 'later'

async function multiSelect<T extends string>(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  items: Array<SelectItem<T>>,
): Promise<T[]> {
  if (items.length === 0) return []

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const input = await ask(
      rl,
      `${prompt} (comma-separated, empty for none, "all" for all): `,
    )
    const normalized = input.trim().toLowerCase()
    if (!normalized) return []
    if (normalized === 'all') return items.map((item) => item.value)

    const requested = new Set(normalized.split(',').map((item) => item.trim()).filter(Boolean))
    return items
      .filter((item) => requested.has(item.value.toLowerCase()))
      .map((item) => item.value)
  }

  return await new Promise<T[]>((resolve, reject) => {
    let cursor = 0
    const selected = new Set<T>()
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

async function singleSelect<T extends string>(
  rl: ReturnType<typeof createInterface>,
  prompt: string,
  items: Array<SelectItem<T>>,
): Promise<T> {
  if (items.length === 0) throw new Error('No options available')
  const defaultIndex = Math.max(0, items.findIndex((item) => item.selected))

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const input = await ask(
      rl,
      `${prompt} (${items.map((item, index) => `${index + 1}=${item.label}`).join(', ')}, default: ${defaultIndex + 1}): `,
    )
    const normalized = input.trim().toLowerCase()
    if (!normalized) return items[defaultIndex].value

    const numericIndex = Number(normalized)
    if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= items.length) {
      return items[numericIndex - 1].value
    }

    return items.find((item) => (
      item.value.toLowerCase() === normalized
      || item.label.toLowerCase() === normalized
    ))?.value ?? items[defaultIndex].value
  }

  return await new Promise<T>((resolve, reject) => {
    let cursor = defaultIndex
    let renderedLines = 0

    const render = () => {
      if (renderedLines > 0) {
        process.stdout.write(`\x1B[${renderedLines}A\x1B[0J`)
      }

      const lines = [
        `${prompt} (↑/↓ to move, Enter to confirm)`,
        ...items.map((item, index) => {
          const pointer = index === cursor ? '>' : ' '
          const details = item.description ? ` ${item.description}` : ''
          return `${pointer} ${item.label}${details}`
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
        case 'return':
        case 'enter':
          cleanup()
          resolve(items[cursor].value)
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

function formatPolicySenders(policies: SenderPolicy[]): string {
  return policies.map((policy) => policy.sender).join(', ')
}

interface ReusableSenderPolicies {
  label: string
  policies: SenderPolicy[]
}

function getReusableSenderPolicies(
  name: string,
  previousPolicies: SenderPolicy[] | undefined,
  allPreviousPolicies: Map<string, SenderPolicy[]>,
): ReusableSenderPolicies[] {
  const reusablePolicies: ReusableSenderPolicies[] = []
  if (previousPolicies?.length) {
    reusablePolicies.push({ label: `${name} (current)`, policies: previousPolicies })
  }

  reusablePolicies.push(...[...allPreviousPolicies.entries()]
    .filter(([agentName, policies]) => agentName !== name && policies.length > 0)
    .map(([agentName, policies]) => ({ label: agentName, policies })))

  return reusablePolicies
}

async function promptReusableSenderPolicies(
  rl: ReturnType<typeof createInterface>,
  name: string,
  previousPolicies: SenderPolicy[] | undefined,
  allPreviousPolicies: Map<string, SenderPolicy[]>,
): Promise<SenderPolicy[] | undefined> {
  const reusablePolicies = getReusableSenderPolicies(name, previousPolicies, allPreviousPolicies)
  if (reusablePolicies.length === 0) {
    return undefined
  }

  if (reusablePolicies.length === 1) {
    const [selected] = reusablePolicies
    console.log(`  Reusing sender policies from ${selected.label} (${formatPolicySenders(selected.policies)})`)
    return selected.policies
  }

  const selectedIndex = await singleSelect(
    rl,
    `? Reuse which sender policies for ${name}?`,
    reusablePolicies.map(({ label, policies }, index) => ({
      value: String(index),
      label,
      description: `(${formatPolicySenders(policies)})`,
      selected: index === 0,
    })),
  )
  return reusablePolicies[Number(selectedIndex)].policies
}

async function promptManualSenderPolicies(
  rl: ReturnType<typeof createInterface>,
  name: string,
): Promise<SenderPolicy[] | undefined> {
  const sendersInput = await ask(
    rl,
    `? Allowed sender emails for ${name} (comma-separated): `,
  )
  const senders = parseEmailList(sendersInput)
  if (senders.length === 0) {
    console.log(`  Warning: no valid sender entries provided; ${name} will reject all senders until paired or configured.`)
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

async function promptSenderPolicies(
  rl: ReturnType<typeof createInterface>,
  name: string,
  method: Extract<ConnectionSetupMethod, 'manual-sender-policy' | 'reuse-sender-policy'>,
  previousPolicies: SenderPolicy[] | undefined,
  allPreviousPolicies: Map<string, SenderPolicy[]>,
): Promise<SenderPolicy[] | undefined> {
  if (method === 'reuse-sender-policy') {
    return promptReusableSenderPolicies(rl, name, previousPolicies, allPreviousPolicies)
  }

  return promptManualSenderPolicies(rl, name)
}

async function promptConnectionSetupMethod(
  rl: ReturnType<typeof createInterface>,
  name: string,
  canReuseSenderPolicy: boolean,
): Promise<ConnectionSetupMethod> {
  return singleSelect(rl, `? How should ${name} authorize senders?`, [
    {
      value: 'pairing-code',
      label: 'Pair with QR code',
      description: '(recommended)',
      selected: true,
    },
    {
      value: 'manual-sender-policy',
      label: 'Manually enter sender policy',
    },
    ...(canReuseSenderPolicy ? [{
      value: 'reuse-sender-policy' as const,
      label: 'Reuse existing sender policy',
    }] : []),
    {
      value: 'later',
      label: 'Configure later',
    },
  ])
}

function detectAgent(name: string): string | null {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' })
    try {
      const version = execSync(`${name} --version 2>/dev/null || echo unknown`, { stdio: 'pipe' }).toString().trim().split('\n')[0]
      return version
    } catch {
      return 'installed'
    }
  } catch {
    return null
  }
}

function renderQrFallback(value: string): void {
  console.log('  Could not render a terminal QR code. Paste this pairing URL instead:')
  console.log(`  ${value}`)
}

function renderTerminalQr(value: string): void {
  const qrModule = ((qrcode as unknown as {
    generate?: (input: string, opts: { small: boolean }, cb: (qr: string) => void) => void
    default?: { generate?: (input: string, opts: { small: boolean }, cb: (qr: string) => void) => void }
  }).generate ? qrcode : (qrcode as unknown as {
    default?: { generate?: (input: string, opts: { small: boolean }, cb: (qr: string) => void) => void }
  }).default) as
    | { generate?: (input: string, opts: { small: boolean }, cb: (qr: string) => void) => void }
    | undefined

  if (!qrModule?.generate) {
    renderQrFallback(value)
    return
  }

  try {
    console.log('  Scan this QR code with AAMP App:')
    qrModule.generate(pairingUrlToWebUrl(value), { small: true }, (qr) => console.log(qr))
  } catch {
    renderQrFallback(value)
  }
}

export function renderPairingCode(name: string, mailbox: string, pairingFile: string): void {
  const pairing = createPairingCode({ mailbox, file: pairingFile })
  console.log(`\n  Pair ${name} with AAMP App (expires ${pairing.expiresAt})`)
  renderTerminalQr(pairing.connectUrl)
  console.log(`  Pairing URL: ${pairing.connectUrl}`)
}

export async function runInit(configPath: string, opts: { agent?: string } = {}): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('\nAAMP ACP Bridge Setup\n')

  // 1. AAMP host
  const aampHostInput = (await ask(rl, '? AAMP Service URL (default: https://meshmail.ai): ')).trim()
  const aampHost = aampHostInput || 'https://meshmail.ai'
  if (!aampHost) { rl.close(); throw new Error('AAMP host is required') }

  // Verify connectivity
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

  // 2. Scan for ACP agents
  const scanTargets = opts.agent
    ? KNOWN_AGENTS.filter((name) => name === opts.agent)
    : KNOWN_AGENTS
  if (opts.agent && scanTargets.length === 0) {
    rl.close()
    throw new Error(`Unknown ACP agent "${opts.agent}". Known agents: ${KNOWN_AGENTS.join(', ')}`)
  }

  console.log(opts.agent ? `? Scanning for ACP agent: ${opts.agent}` : '? Scanning for ACP agents...')
  const detected: Array<{ name: string; version: string }> = []
  for (const name of scanTargets) {
    const version = detectAgent(name)
    if (version) {
      console.log(`  + ${name.padEnd(12)} (${version})`)
      detected.push({ name, version })
    } else {
      console.log(`  - ${name.padEnd(12)} (not installed)`)
    }
  }
  console.log()

  if (detected.length === 0) {
    console.log('No ACP agents found. Install an agent first (e.g. npm i -g @anthropic-ai/claude-code).')
    rl.close()
    return false
  }

  // 3. Select agents
  const selected = opts.agent
    ? detected.map(({ name }) => name)
    : await multiSelect(
        rl,
        '? Select ACP agents to bridge',
        detected.map(({ name, version }) => ({
          value: name,
          label: name,
          description: `(${version})`,
        })),
      )

  if (selected.length === 0) {
    console.log('No agents selected. Exiting.')
    rl.close()
    return false
  }

  // 4. Register AAMP identities
  console.log('\n? Registering AAMP identities...')
  const agents: AgentConfig[] = []
  const previousSenderPolicies = loadPreviousSenderPolicies(configPath)

  for (const name of selected) {
    const slug = `${name}-bridge`
    const credFile = getDefaultCredentialsPath(name)
    const pairingFile = defaultPairingFile(name)
    const senderPoliciesFile = defaultSenderPoliciesFile(name)
    const previousPolicies = previousSenderPolicies.get(name)
    const canReuseSenderPolicy = getReusableSenderPolicies(name, previousPolicies, previousSenderPolicies).length > 0
    const connectionSetup = await promptConnectionSetupMethod(rl, name, canReuseSenderPolicy)
    const senderPolicies = connectionSetup === 'manual-sender-policy' || connectionSetup === 'reuse-sender-policy'
      ? await promptSenderPolicies(
          rl,
          name,
          connectionSetup,
          previousPolicies,
          previousSenderPolicies,
        )
      : undefined

    if (existsSync(credFile)) {
      console.log(`  + ${name} -> using existing credentials (${credFile})`)
      const saved = JSON.parse(readFileSync(credFile, 'utf-8')) as { email?: string }
      if (connectionSetup === 'pairing-code' && saved.email) {
        renderPairingCode(name, saved.email, pairingFile)
      } else if (connectionSetup === 'later') {
        console.log(`  Sender authorization for ${name} was left for later; task.dispatch will be rejected until paired or configured.`)
      }
      agents.push({
        name,
        acpCommand: name,
        slug,
        credentialsFile: credFile,
        pairingFile,
        senderPoliciesFile,
        senderPolicies,
      })
      continue
    }

    try {
      const creds = await AampClient.registerMailbox({
        aampHost,
        slug,
        description: `${name} via ACP bridge`,
      })

      mkdirSync(dirname(credFile), { recursive: true })
      writeFileSync(credFile, JSON.stringify({
        email: creds.email,
        mailboxToken: creds.mailboxToken,
        smtpPassword: creds.smtpPassword,
      }, null, 2))

      console.log(`  + ${name} -> ${creds.email}`)
      if (connectionSetup === 'pairing-code') {
        renderPairingCode(name, creds.email, pairingFile)
      } else if (connectionSetup === 'later') {
        console.log(`  Sender authorization for ${name} was left for later; task.dispatch will be rejected until paired or configured.`)
      }
      agents.push({
        name,
        acpCommand: name,
        slug,
        credentialsFile: credFile,
        pairingFile,
        senderPoliciesFile,
        description: `${name} via ACP bridge`,
        senderPolicies,
      })
    } catch (err) {
      console.log(`  x ${name} -> registration failed: ${(err as Error).message}`)
    }
  }

  if (agents.length === 0) {
    console.log('No agents registered. Exiting.')
    rl.close()
    return false
  }

  // 5. Write config
  const config: BridgeConfig = { aampHost, rejectUnauthorized: false, agents }
  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log(`\nConfig written to ${configPath}`)

  rl.close()
  return true
}
