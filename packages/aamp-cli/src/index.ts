#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { AampClient, type ReceivedAttachment, type SendHelpOptions, type SendResultOptions, type SendTaskOptions } from 'aamp-sdk'

type CommandName = 'init' | 'login' | 'listen' | 'dispatch' | 'result' | 'help' | 'status' | 'inbox' | 'unknown'

interface ParsedArgs {
  command: CommandName
  positionals: string[]
  values: Record<string, string[]>
  booleans: Set<string>
}

interface CliProfile {
  email: string
  jmapToken: string
  smtpPassword: string
  jmapUrl: string
  smtpHost?: string
  smtpPort?: number
  rejectUnauthorized?: boolean
}

const DEFAULT_PROFILE = 'default'
const DEFAULT_JMAP_URL = 'https://meshmail.ai'

function deriveServiceDefaults(email: string): { jmapUrl: string; smtpHost: string } {
  const domain = email.split('@')[1]?.trim()
  if (!domain) {
    return { jmapUrl: DEFAULT_JMAP_URL, smtpHost: new URL(DEFAULT_JMAP_URL).hostname }
  }
  return {
    jmapUrl: `https://${domain}`,
    smtpHost: domain,
  }
}

function printUsage(): void {
  console.log(`AAMP CLI

Usage:
  aamp-cli login [--profile NAME]
  aamp-cli init [--profile NAME]
  aamp-cli listen [--profile NAME]
  aamp-cli status [--profile NAME]
  aamp-cli inbox [--profile NAME] [--limit N]
  aamp-cli dispatch --to EMAIL --title TEXT [--body TEXT] [--timeout SECS] [--context-link URL]...
  aamp-cli result --to EMAIL --task-id ID --status completed|rejected [--output TEXT] [--error TEXT]
  aamp-cli help --to EMAIL --task-id ID --question TEXT [--reason TEXT] [--option TEXT]...

Examples:
  aamp-cli login
  aamp-cli listen --profile default
  aamp-cli dispatch --to agent@meshmail.ai --title "Review this patch" --body "Please review PR #42"
  aamp-cli result --to workflow@meshmail.ai --task-id 123 --status completed --output "Done"
  aamp-cli help --to workflow@meshmail.ai --task-id 123 --question "Which environment?" --option staging --option production
`)
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv
  const command = (rawCommand ?? 'unknown') as CommandName
  const positionals: string[] = []
  const values: Record<string, string[]> = {}
  const booleans = new Set<string>()

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const key = token.slice(2)
    const next = rest[i + 1]
    if (!next || next.startsWith('--')) {
      booleans.add(key)
      continue
    }
    if (!values[key]) values[key] = []
    values[key].push(next)
    i++
  }

  return { command, positionals, values, booleans }
}

function firstArg(args: ParsedArgs, key: string): string | undefined {
  return args.values[key]?.[0]
}

function allArgs(args: ParsedArgs, key: string): string[] {
  return args.values[key] ?? []
}

function requireArg(args: ParsedArgs, key: string): string {
  const value = firstArg(args, key)
  if (!value) throw new Error(`Missing required --${key}`)
  return value
}

function getProfilesDir(): string {
  return path.join(os.homedir(), '.aamp-cli', 'profiles')
}

function getProfilePath(profile = DEFAULT_PROFILE): string {
  return path.join(getProfilesDir(), `${profile}.json`)
}

async function loadProfile(profile = DEFAULT_PROFILE): Promise<CliProfile> {
  const file = getProfilePath(profile)
  if (!existsSync(file)) {
    throw new Error(`Profile "${profile}" not found. Run "aamp-cli login${profile === DEFAULT_PROFILE ? '' : ` --profile ${profile}`}" first.`)
  }
  const raw = await readFile(file, 'utf8')
  return JSON.parse(raw) as CliProfile
}

async function saveProfile(profile: string, data: CliProfile): Promise<string> {
  const dir = getProfilesDir()
  await mkdir(dir, { recursive: true })
  const file = getProfilePath(profile)
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  return file
}

function resolveSmtpHost(jmapUrl: string, explicit?: string): string {
  return explicit || new URL(jmapUrl).hostname
}

function createClient(profile: CliProfile): AampClient {
  return new AampClient({
    email: profile.email,
    jmapToken: profile.jmapToken,
    jmapUrl: profile.jmapUrl,
    smtpHost: resolveSmtpHost(profile.jmapUrl, profile.smtpHost),
    smtpPort: profile.smtpPort ?? 587,
    smtpPassword: profile.smtpPassword,
    rejectUnauthorized: profile.rejectUnauthorized,
  })
}

function formatTransport(client: AampClient): string {
  return client.isUsingPollingFallback() ? 'polling fallback' : 'websocket'
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

async function runInit(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const existingFile = getProfilePath(profile)
  const existing = existsSync(existingFile) ? await loadProfile(profile) : null

  const email = firstArg(args, 'email') ?? await prompt('Mailbox email', existing?.email ?? '')
  const smtpPassword = firstArg(args, 'password') ?? firstArg(args, 'smtp-password') ?? await prompt('Mailbox password', existing?.smtpPassword ?? '')
  const jmapToken = Buffer.from(`${email}:${smtpPassword}`).toString('base64')
  const inferred = deriveServiceDefaults(email)
  const jmapUrl = firstArg(args, 'jmap-url') ?? existing?.jmapUrl ?? inferred.jmapUrl
  const smtpHost = firstArg(args, 'smtp-host') ?? existing?.smtpHost ?? inferred.smtpHost
  const smtpPort = Number(firstArg(args, 'smtp-port') ?? String(existing?.smtpPort ?? 587))
  const rejectUnauthorized = (firstArg(args, 'reject-unauthorized') ?? String(existing?.rejectUnauthorized ?? true)) !== 'false'

  const file = await saveProfile(profile, {
    email,
    jmapToken,
    smtpPassword,
    jmapUrl,
    smtpHost,
    smtpPort,
    rejectUnauthorized,
  })

  console.log(`Saved profile "${profile}" to ${file}`)
  console.log(`Derived JMAP URL: ${jmapUrl}`)
  console.log(`Derived SMTP host: ${smtpHost}:${smtpPort}`)
}

async function runLogin(args: ParsedArgs): Promise<void> {
  await runInit(args)
}

function printDispatch(task: {
  taskId: string
  title: string
  from: string
  bodyText?: string
  timeoutSecs?: number
  contextLinks?: string[]
  attachments?: ReceivedAttachment[]
  dispatchContext?: Record<string, string>
}): void {
  console.log(`\n[AAMP] <- task.dispatch ${task.taskId}`)
  console.log(`  from: ${task.from}`)
  console.log(`  title: ${task.title}`)
  if (task.timeoutSecs) console.log(`  timeout: ${task.timeoutSecs}s`)
  if (task.contextLinks?.length) console.log(`  contextLinks: ${task.contextLinks.join(', ')}`)
  if (task.dispatchContext && Object.keys(task.dispatchContext).length) {
    console.log(`  dispatchContext: ${JSON.stringify(task.dispatchContext)}`)
  }
  if (task.attachments?.length) {
    console.log(`  attachments: ${task.attachments.map((item) => item.filename).join(', ')}`)
  }
  if (task.bodyText?.trim()) {
    console.log('  body:')
    console.log(task.bodyText.split('\n').map((line) => `    ${line}`).join('\n'))
  }
}

async function runListen(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  let lastErrorSignature = ''

  client.on('connected', () => {
    console.log(`[AAMP] connected as ${client.email} (${formatTransport(client)})`)
  })
  client.on('disconnected', (reason) => {
    console.log(`[AAMP] disconnected: ${reason}`)
  })
  client.on('error', (err) => {
    const isFallbackActive = client.isUsingPollingFallback()
    const isHandshakeNoise = err.message.startsWith('JMAP WebSocket handshake failed:')
    const isFallbackTransition = err.message.startsWith('JMAP WebSocket unavailable, falling back to polling:')
    if (isFallbackTransition) {
      console.log(`[AAMP] websocket unavailable, using polling fallback`)
      return
    }
    if (isFallbackActive && isHandshakeNoise) return
    if (err.message === lastErrorSignature) return
    lastErrorSignature = err.message
    console.error(`[AAMP] error: ${err.message}`)
  })
  client.on('task.dispatch', (task) => {
    printDispatch(task)
  })
  client.on('task.ack', (ack) => {
    console.log(`\n[AAMP] <- task.ack ${ack.taskId} from=${ack.from}`)
  })
  client.on('task.help', (help) => {
    console.log(`\n[AAMP] <- task.help ${help.taskId} from=${help.from}`)
    console.log(`  question: ${help.question}`)
    if (help.blockedReason) console.log(`  blockedReason: ${help.blockedReason}`)
    if (help.suggestedOptions?.length) console.log(`  suggestedOptions: ${help.suggestedOptions.join(', ')}`)
  })
  client.on('task.result', (result) => {
    console.log(`\n[AAMP] <- task.result ${result.taskId} from=${result.from} status=${result.status}`)
    if (result.output) console.log(`  output: ${result.output}`)
    if (result.errorMsg) console.log(`  error: ${result.errorMsg}`)
    if (result.attachments?.length) console.log(`  attachments: ${result.attachments.map((item) => item.filename).join(', ')}`)
  })
  client.on('reply', (reply) => {
    console.log(`\n[AAMP] <- human reply inReplyTo=${reply.inReplyTo} from=${reply.from}`)
    console.log(`  body: ${reply.bodyText}`)
  })

  await client.connect()
  console.log(`[AAMP] listening as ${client.email}; press Ctrl+C to stop`)

  const shutdown = () => {
    client.disconnect()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await new Promise<void>(() => {})
}

async function runStatus(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const cfg = await loadProfile(profile)
  const client = createClient(cfg)
  const smtpOk = await client.verifySmtp().catch(() => false)
  await client.connect()
  console.log(JSON.stringify({
    profile,
    email: cfg.email,
    jmapUrl: cfg.jmapUrl,
    smtpHost: resolveSmtpHost(cfg.jmapUrl, cfg.smtpHost),
    smtpPort: cfg.smtpPort ?? 587,
    transport: formatTransport(client),
    smtpVerified: smtpOk,
  }, null, 2))
  client.disconnect()
}

async function runInbox(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const limit = Number(firstArg(args, 'limit') ?? '20')
  const client = createClient(await loadProfile(profile))
  const processed = await client.reconcileRecentEmails(limit)
  console.log(`Reconciled ${processed} recent email(s)`)
}

async function runDispatch(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const payload: SendTaskOptions = {
    to: requireArg(args, 'to'),
    title: requireArg(args, 'title'),
    bodyText: firstArg(args, 'body'),
    timeoutSecs: firstArg(args, 'timeout') ? Number(firstArg(args, 'timeout')) : undefined,
    contextLinks: allArgs(args, 'context-link'),
  }
  const result = await client.sendTask(payload)
  console.log(JSON.stringify(result, null, 2))
}

async function runResult(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const payload: SendResultOptions = {
    to: requireArg(args, 'to'),
    taskId: requireArg(args, 'task-id'),
    status: requireArg(args, 'status') as 'completed' | 'rejected',
    output: firstArg(args, 'output') ?? '',
    errorMsg: firstArg(args, 'error'),
  }
  await client.sendResult(payload)
  console.log(`Sent task.result for ${payload.taskId}`)
}

async function runHelp(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const payload: SendHelpOptions = {
    to: requireArg(args, 'to'),
    taskId: requireArg(args, 'task-id'),
    question: requireArg(args, 'question'),
    blockedReason: firstArg(args, 'reason') ?? '',
    suggestedOptions: allArgs(args, 'option'),
  }
  await client.sendHelp(payload)
  console.log(`Sent task.help for ${payload.taskId}`)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.booleans.has('help') || args.command === 'unknown') {
    printUsage()
    return
  }

  switch (args.command) {
    case 'login':
      await runLogin(args)
      return
    case 'init':
      await runInit(args)
      return
    case 'listen':
      await runListen(args)
      return
    case 'status':
      await runStatus(args)
      return
    case 'inbox':
      await runInbox(args)
      return
    case 'dispatch':
      await runDispatch(args)
      return
    case 'result':
      await runResult(args)
      return
    case 'help':
      await runHelp(args)
      return
    default:
      printUsage()
  }
}

main().catch((err) => {
  console.error(`[aamp-cli] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
