#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { stdin as input, stdout as output } from 'node:process'
import {
  AampClient,
  renderThreadHistoryForAgent,
  type HydratedTaskDispatch,
  type ReceivedAttachment,
  type SendCancelOptions,
  type SendHelpOptions,
  type SendResultOptions,
  type SendTaskOptions,
} from 'aamp-sdk'

type CommandName =
  | 'init'
  | 'login'
  | 'register'
  | 'listen'
  | 'dispatch'
  | 'result'
  | 'help'
  | 'cancel'
  | 'status'
  | 'inbox'
  | 'thread'
  | 'directory-list'
  | 'directory-search'
  | 'directory-update'
  | 'card-query'
  | 'card-response'
  | 'unknown'

interface ParsedArgs {
  command: CommandName
  positionals: string[]
  values: Record<string, string[]>
  booleans: Set<string>
}

interface CliProfile {
  email: string
  smtpPassword: string
  baseUrl?: string
  smtpHost?: string
  smtpPort?: number
  rejectUnauthorized?: boolean
}

const DEFAULT_PROFILE = 'default'
const DEFAULT_BASE_URL = 'https://meshmail.ai'

export function deriveServiceDefaults(email: string): { baseUrl: string; smtpHost: string } {
  const domain = email.split('@')[1]?.trim()
  if (!domain) {
    return { baseUrl: DEFAULT_BASE_URL, smtpHost: new URL(DEFAULT_BASE_URL).hostname }
  }
  return {
    baseUrl: `https://${domain}`,
    smtpHost: domain,
  }
}

function printUsage(): void {
  console.log(`AAMP CLI

Usage:
  aamp-cli login [--profile NAME]
  aamp-cli register [--profile NAME] [--host URL] [--slug NAME]
  aamp-cli init [--profile NAME]
  aamp-cli listen [--profile NAME]
  aamp-cli status [--profile NAME]
  aamp-cli inbox [--profile NAME] [--limit N]
  aamp-cli thread --task-id ID [--profile NAME] [--include-stream-opened]
  aamp-cli directory-list [--profile NAME] [--include-self] [--limit N]
  aamp-cli directory-search --query TEXT [--profile NAME] [--include-self] [--limit N]
  aamp-cli directory-update [--profile NAME] [--summary TEXT] [--card-text TEXT] [--card-file PATH]
  aamp-cli dispatch --to EMAIL --title TEXT [--body TEXT] [--priority urgent|high|normal] [--expires-at ISO] [--context-link URL]...
  aamp-cli result --to EMAIL --task-id ID --status completed|rejected [--output TEXT] [--error TEXT]
  aamp-cli help --to EMAIL --task-id ID --question TEXT [--reason TEXT] [--option TEXT]...
  aamp-cli cancel --to EMAIL --task-id ID [--body TEXT]
  aamp-cli card-query --to EMAIL [--body TEXT]
  aamp-cli card-response --to EMAIL --task-id ID --summary TEXT [--body TEXT] [--card-file PATH]

Examples:
  aamp-cli login
  aamp-cli register --host https://meshmail.ai --slug openclaw-agent
  aamp-cli listen --profile default
  aamp-cli directory-search --query reviewer
  aamp-cli dispatch --to agent@meshmail.ai --title "Review this patch" --priority high --body "Please review PR #42"
  aamp-cli result --to meego@meshmail.ai --task-id 123 --status completed --output "Done"
  aamp-cli help --to meego@meshmail.ai --task-id 123 --question "Which environment?" --option staging --option production
  aamp-cli cancel --to agent@meshmail.ai --task-id 123 --body "No longer needed"
  aamp-cli card-query --to agent@meshmail.ai --query "What services do you provide?"
`)
}

export function parseArgs(argv: string[]): ParsedArgs {
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

function resolveBaseUrl(profile: CliProfile): string {
  return profile.baseUrl || deriveServiceDefaults(profile.email).baseUrl
}

function resolveSmtpHost(baseUrl: string, explicit?: string): string {
  return explicit || new URL(baseUrl).hostname
}

function createClient(profile: CliProfile): AampClient {
  const baseUrl = resolveBaseUrl(profile)
  return AampClient.fromMailboxIdentity({
    email: profile.email,
    smtpPassword: profile.smtpPassword,
    baseUrl,
    smtpPort: profile.smtpPort ?? 587,
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

export async function runInit(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const existingFile = getProfilePath(profile)
  const existing = existsSync(existingFile) ? await loadProfile(profile) : null

  const email = firstArg(args, 'email') ?? await prompt('Mailbox email', existing?.email ?? '')
  const smtpPassword = firstArg(args, 'password') ?? firstArg(args, 'smtp-password') ?? await prompt('Mailbox password', existing?.smtpPassword ?? '')
  const inferred = deriveServiceDefaults(email)
  const baseUrl = firstArg(args, 'base-url') ?? existing?.baseUrl ?? inferred.baseUrl
  const smtpHost = firstArg(args, 'smtp-host') ?? existing?.smtpHost ?? inferred.smtpHost
  const smtpPort = Number(firstArg(args, 'smtp-port') ?? String(existing?.smtpPort ?? 587))
  const rejectUnauthorized = (firstArg(args, 'reject-unauthorized') ?? String(existing?.rejectUnauthorized ?? true)) !== 'false'

  const file = await saveProfile(profile, {
    email,
    smtpPassword,
    baseUrl,
    smtpHost,
    smtpPort,
    rejectUnauthorized,
  })

  console.log(`Saved profile "${profile}" to ${file}`)
  console.log(`Derived base URL: ${baseUrl}`)
  console.log(`Derived SMTP host: ${smtpHost}:${smtpPort}`)
}

export async function runLogin(args: ParsedArgs): Promise<void> {
  await runInit(args)
}

export async function runRegister(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const host = firstArg(args, 'host') ?? await prompt('AAMP host', DEFAULT_BASE_URL)
  const slugInput = firstArg(args, 'slug') ?? await prompt('Mailbox slug', 'agent')
  const slug = slugInput.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
  if (slug.length < 2) {
    throw new Error('Mailbox slug must be at least 2 characters')
  }

  const identity = await AampClient.registerMailbox({
    aampHost: host,
    slug,
    description: `Registered via aamp-cli (${profile})`,
  })

  const inferred = deriveServiceDefaults(identity.email)
  const file = await saveProfile(profile, {
    email: identity.email,
    smtpPassword: identity.smtpPassword,
    baseUrl: identity.baseUrl,
    smtpHost: inferred.smtpHost,
    smtpPort: 587,
    rejectUnauthorized: true,
  })

  console.log(JSON.stringify({
    profile,
    email: identity.email,
    baseUrl: identity.baseUrl,
    mailboxToken: identity.mailboxToken,
    savedTo: file,
  }, null, 2))
}

export function printDispatch(task: {
  taskId: string
  title: string
  from: string
  priority?: 'urgent' | 'high' | 'normal'
  expiresAt?: string
  bodyText?: string
  contextLinks?: string[]
  attachments?: ReceivedAttachment[]
  dispatchContext?: Record<string, string>
  threadContextText?: string
}, logger: Pick<typeof console, 'log'> = console): void {
  logger.log(`\n[AAMP] <- task.dispatch ${task.taskId}`)
  logger.log(`  from: ${task.from}`)
  logger.log(`  title: ${task.title}`)
  logger.log(`  priority: ${task.priority}`)
  if (task.expiresAt) logger.log(`  expiresAt: ${task.expiresAt}`)
  if (task.contextLinks?.length) logger.log(`  contextLinks: ${task.contextLinks.join(', ')}`)
  if (task.dispatchContext && Object.keys(task.dispatchContext).length) {
    logger.log(`  dispatchContext: ${JSON.stringify(task.dispatchContext)}`)
  }
  if (task.attachments?.length) {
    logger.log(`  attachments: ${task.attachments.map((item) => item.filename).join(', ')}`)
  }
  if (task.threadContextText?.trim()) {
    logger.log('  priorContext:')
    logger.log(task.threadContextText.split('\n').map((line) => `    ${line}`).join('\n'))
  }
  if (task.bodyText?.trim()) {
    logger.log('  body:')
    logger.log(task.bodyText.split('\n').map((line) => `    ${line}`).join('\n'))
  }
}

type ListenClient = Pick<
  AampClient,
  'on' | 'email' | 'isUsingPollingFallback' | 'connect' | 'disconnect' | 'hydrateTaskDispatch'
>

type ListenLogger = Pick<typeof console, 'log' | 'error'>

export function attachListenHandlers(client: ListenClient, logger: ListenLogger = console): void {
  let lastErrorSignature = ''

  client.on('connected', () => {
    logger.log(`[AAMP] connected as ${client.email} (${formatTransport(client as AampClient)})`)
  })
  client.on('disconnected', (reason) => {
    logger.log(`[AAMP] disconnected: ${reason}`)
  })
  client.on('error', (err) => {
    const isFallbackActive = client.isUsingPollingFallback()
    const isHandshakeNoise = err.message.startsWith('JMAP WebSocket handshake failed:')
    const isFallbackTransition = err.message.startsWith('JMAP WebSocket unavailable, falling back to polling:')
    if (isFallbackTransition) {
      logger.log(`[AAMP] websocket unavailable, using polling fallback`)
      return
    }
    if (isFallbackActive && isHandshakeNoise) return
    if (err.message === lastErrorSignature) return
    lastErrorSignature = err.message
    logger.error(`[AAMP] error: ${err.message}`)
  })
  client.on('task.dispatch', (task) => {
    void client.hydrateTaskDispatch(task)
      .then((hydrated: HydratedTaskDispatch) => {
        printDispatch(hydrated, logger)
      })
      .catch(() => {
        printDispatch(task, logger)
      })
  })
  client.on('task.cancel', (cancel) => {
    logger.log(`\n[AAMP] <- task.cancel ${cancel.taskId} from=${cancel.from}`)
    if (cancel.bodyText?.trim()) logger.log(`  body: ${cancel.bodyText}`)
  })
  client.on('task.ack', (ack) => {
    logger.log(`\n[AAMP] <- task.ack ${ack.taskId} from=${ack.from}`)
  })
  client.on('task.help_needed', (help) => {
    logger.log(`\n[AAMP] <- task.help_needed ${help.taskId} from=${help.from}`)
    logger.log(`  question: ${help.question}`)
    if (help.blockedReason) logger.log(`  blockedReason: ${help.blockedReason}`)
    if (help.suggestedOptions?.length) logger.log(`  suggestedOptions: ${help.suggestedOptions.join(', ')}`)
  })
  client.on('task.result', (result) => {
    logger.log(`\n[AAMP] <- task.result ${result.taskId} from=${result.from} status=${result.status}`)
    if (result.output) logger.log(`  output: ${result.output}`)
    if (result.errorMsg) logger.log(`  error: ${result.errorMsg}`)
    if (result.attachments?.length) logger.log(`  attachments: ${result.attachments.map((item) => item.filename).join(', ')}`)
  })
  client.on('card.query', (cardQuery) => {
    logger.log(`\n[AAMP] <- card.query ${cardQuery.taskId} from=${cardQuery.from}`)
    logger.log(`  subject: ${cardQuery.subject}`)
    if (cardQuery.bodyText?.trim()) logger.log(`  body: ${cardQuery.bodyText}`)
  })
  client.on('card.response', (cardResponse) => {
    logger.log(`\n[AAMP] <- card.response ${cardResponse.taskId} from=${cardResponse.from}`)
    logger.log(`  summary: ${cardResponse.summary}`)
    if (cardResponse.bodyText?.trim()) logger.log(`  body: ${cardResponse.bodyText}`)
  })
  client.on('reply', (reply) => {
    logger.log(`\n[AAMP] <- human reply inReplyTo=${reply.inReplyTo} from=${reply.from}`)
    logger.log(`  body: ${reply.bodyText}`)
  })
}

export async function runListen(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  attachListenHandlers(client)
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

export async function runStatus(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const cfg = await loadProfile(profile)
  const client = createClient(cfg)
  const smtpOk = await client.verifySmtp().catch(() => false)
  await client.connect()
  console.log(JSON.stringify({
    profile,
    email: cfg.email,
    baseUrl: resolveBaseUrl(cfg),
    smtpHost: resolveSmtpHost(resolveBaseUrl(cfg), cfg.smtpHost),
    smtpPort: cfg.smtpPort ?? 587,
    transport: formatTransport(client),
    smtpVerified: smtpOk,
  }, null, 2))
  client.disconnect()
}

export async function runInbox(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const limit = Number(firstArg(args, 'limit') ?? '20')
  const client = createClient(await loadProfile(profile))
  const processed = await client.reconcileRecentEmails(limit)
  console.log(`Reconciled ${processed} recent email(s)`)
}

export async function runThread(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const taskId = requireArg(args, 'task-id')
  const history = await client.getThreadHistory(taskId, {
    includeStreamOpened: args.booleans.has('include-stream-opened'),
  })
  console.log(JSON.stringify({
    taskId: history.taskId,
    context: renderThreadHistoryForAgent(history.events),
    events: history.events,
  }, null, 2))
}

export async function runDispatch(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const payload: SendTaskOptions = {
    to: requireArg(args, 'to'),
    title: requireArg(args, 'title'),
    bodyText: firstArg(args, 'body'),
    priority: firstArg(args, 'priority') as SendTaskOptions['priority'] | undefined,
    expiresAt: firstArg(args, 'expires-at'),
    contextLinks: allArgs(args, 'context-link'),
  }
  const result = await client.sendTask(payload)
  console.log(JSON.stringify(result, null, 2))
}

export async function runResult(args: ParsedArgs): Promise<void> {
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

export async function runHelp(args: ParsedArgs): Promise<void> {
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
  console.log(`Sent task.help_needed for ${payload.taskId}`)
}

export async function runCancel(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const payload: SendCancelOptions = {
    to: requireArg(args, 'to'),
    taskId: requireArg(args, 'task-id'),
    bodyText: firstArg(args, 'body'),
  }
  await client.sendCancel(payload)
  console.log(`Sent task.cancel for ${payload.taskId}`)
}

export async function runDirectoryList(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const agents = await client.listDirectory({
    includeSelf: args.booleans.has('include-self'),
    limit: firstArg(args, 'limit') ? Number(firstArg(args, 'limit')) : undefined,
  })
  console.log(JSON.stringify({ agents }, null, 2))
}

export async function runDirectorySearch(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const agents = await client.searchDirectory({
    query: requireArg(args, 'query'),
    includeSelf: args.booleans.has('include-self'),
    limit: firstArg(args, 'limit') ? Number(firstArg(args, 'limit')) : undefined,
  })
  console.log(JSON.stringify({ agents }, null, 2))
}

export async function runDirectoryUpdate(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const cardFile = firstArg(args, 'card-file')
  const cardText = firstArg(args, 'card-text')
    ?? (cardFile ? await readFile(cardFile, 'utf8') : undefined)
  const profileData = await client.updateDirectoryProfile({
    summary: firstArg(args, 'summary'),
    cardText,
  })
  console.log(JSON.stringify({ profile: profileData }, null, 2))
}

export async function runCardQuery(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const result = await client.sendCardQuery({
    to: requireArg(args, 'to'),
    bodyText: firstArg(args, 'body'),
  })
  console.log(JSON.stringify(result, null, 2))
}

export async function runCardResponse(args: ParsedArgs): Promise<void> {
  const profile = firstArg(args, 'profile') ?? DEFAULT_PROFILE
  const client = createClient(await loadProfile(profile))
  const cardFile = firstArg(args, 'card-file')
  const bodyText = firstArg(args, 'body')
    ?? (cardFile ? await readFile(cardFile, 'utf8') : '')
  await client.sendCardResponse({
    to: requireArg(args, 'to'),
    taskId: requireArg(args, 'task-id'),
    summary: requireArg(args, 'summary'),
    bodyText,
  })
  console.log(`Sent card.response for ${requireArg(args, 'task-id')}`)
}

export async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.booleans.has('help') || args.command === 'unknown') {
    printUsage()
    return
  }

  switch (args.command) {
    case 'login':
      await runLogin(args)
      return
    case 'register':
      await runRegister(args)
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
    case 'thread':
      await runThread(args)
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
    case 'cancel':
      await runCancel(args)
      return
    case 'directory-list':
      await runDirectoryList(args)
      return
    case 'directory-search':
      await runDirectorySearch(args)
      return
    case 'directory-update':
      await runDirectoryUpdate(args)
      return
    case 'card-query':
      await runCardQuery(args)
      return
    case 'card-response':
      await runCardResponse(args)
      return
    default:
      printUsage()
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[aamp-cli] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
