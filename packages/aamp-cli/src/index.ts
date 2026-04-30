#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import { stdin as input, stdout as output } from 'node:process'
import {
  AampClient,
  renderThreadHistoryForAgent,
  type AampAttachment,
  type HydratedTaskDispatch,
  type ReceivedAttachment,
  type SendCancelOptions,
  type SendHelpOptions,
  type SendResultOptions,
  type SendTaskOptions,
} from 'aamp-sdk'
import {
  DEFAULT_NODE_NAME,
  createDefaultNodeConfig,
  getNodeCommandSpecsDir,
  getNodeConfigPath,
  loadNodeConfig,
  saveNodeConfig,
  type NodeConfig,
  type RegisteredCommand,
} from './node-config.js'
import {
  buildNodeCapabilityCard,
  createNodeConfigSummary,
  runNodeServe,
} from './node-runtime.js'

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
  | 'node'
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
  aamp-cli node <init|show|serve|sync-card|call|command|policy> ...

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
  aamp-cli node init --email worker@meshmail.ai --password smtp-1
`)
}

function printNodeUsage(): void {
  console.log(`AAMP CLI Node

Usage:
  aamp-cli node init [--node NAME] [--mailbox-profile NAME | --email EMAIL --password PASSWORD] [--base-url URL] [--smtp-host HOST] [--smtp-port N] [--reject-unauthorized true|false] [--host URL] [--slug NAME]
  aamp-cli node show [--node NAME]
  aamp-cli node serve [--node NAME]
  aamp-cli node sync-card [--node NAME]
  aamp-cli node call [--node NAME | --profile NAME] --target EMAIL --command NAME [--title TEXT] [--stream none|status-only|full] [--task-id ID] [--priority urgent|high|normal] [--expires-at ISO] [--context-link URL]... [--dispatch-context KEY=VALUE]... [--arg KEY=VALUE]... [--attachment SLOT=PATH]... [--any_other_key VALUE]...
  aamp-cli node command list [--node NAME]
  aamp-cli node command add [--node NAME] [--spec-file PATH]
  aamp-cli node command remove [--node NAME] --command NAME
  aamp-cli node policy show [--node NAME]
  aamp-cli node policy set [--node NAME] [--default-action allow|deny] [--allow-from EMAIL_OR_PATTERN]... [--allow-command NAME]... [--require-context KEY=VALUE]... [--clear-allow-from] [--clear-allow-command] [--clear-require-context]
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

    const equalsIndex = token.indexOf('=')
    if (equalsIndex > 2) {
      const key = token.slice(2, equalsIndex)
      const value = token.slice(equalsIndex + 1)
      if (!values[key]) values[key] = []
      values[key].push(value)
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

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? 'Y/n' : 'y/N'
  const answer = (await prompt(`${question} [${suffix}]`)).toLowerCase()
  if (!answer) return defaultYes
  if (['y', 'yes'].includes(answer)) return true
  if (['n', 'no'].includes(answer)) return false
  return defaultYes
}

function normalizeSlugInput(inputValue: string): string {
  return inputValue.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
}

async function tryLoadProfile(profile = DEFAULT_PROFILE): Promise<CliProfile | null> {
  try {
    return await loadProfile(profile)
  } catch {
    return null
  }
}

interface TemplateToken {
  kind: 'literal' | 'placeholder'
  value: string
}

interface ParsedCommandTemplate {
  executableToken: string
  tokens: TemplateToken[]
}

type NodeCallStreamMode = 'none' | 'status-only' | 'full'

interface NodeCallOptions {
  to: string
  taskId?: string
  title?: string
  command: string
  args?: Record<string, unknown>
  inputs?: Array<{ slot: string; attachmentName: string }>
  streamMode?: NodeCallStreamMode
  priority?: SendTaskOptions['priority']
  expiresAt?: string
  contextLinks?: string[]
  dispatchContext?: Record<string, string>
  parentTaskId?: string
  attachments?: AampAttachment[]
}

type RegisteredCommandSender = Pick<AampClient, 'email'> & {
  sendRegisteredCommand(opts: NodeCallOptions): Promise<{ taskId: string; messageId: string }>
}

function unquoteToken(token: string): string {
  if (
    (token.startsWith('"') && token.endsWith('"'))
    || (token.startsWith("'") && token.endsWith("'"))
  ) {
    return token.slice(1, -1)
  }
  return token
}

export function parseCommandTemplate(inputValue: string): ParsedCommandTemplate {
  const matches = inputValue.match(/"[^"]*"|'[^']*'|\[[^\]]+\]|\S+/g) ?? []
  if (matches.length === 0) {
    throw new Error('Command template cannot be empty.')
  }

  const [executableToken, ...rest] = matches
  const tokens = rest.map((token): TemplateToken => {
    const placeholder = /^\[([a-zA-Z0-9_-]+)\]$/.exec(token)
    if (placeholder?.[1]) {
      return { kind: 'placeholder', value: placeholder[1] }
    }
    return { kind: 'literal', value: unquoteToken(token) }
  })

  return {
    executableToken: unquoteToken(executableToken ?? ''),
    tokens,
  }
}

export function resolveExecutableOnPath(command: string): string | null {
  if (!command.trim()) return null
  const candidates: string[] = []
  if (command.includes(path.sep) || path.isAbsolute(command)) {
    candidates.push(path.resolve(command))
  } else {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(dir, command))
    }
  }

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      continue
    }
  }
  return null
}

function deriveCommandName(template: ParsedCommandTemplate, execPath: string): string {
  const base = path.basename(execPath)
  const suffix = template.tokens
    .filter((token) => token.kind === 'literal')
    .map((token) => token.value)
    .find((value) => value && !value.startsWith('-'))
  return suffix ? `${base}.${suffix}` : base
}

function parseKeyValueEntry(inputValue: string, flagName: string): { key: string; value: string } {
  const separatorIndex = inputValue.indexOf('=')
  if (separatorIndex <= 0) {
    throw new Error(`Expected --${flagName} to use KEY=VALUE format.`)
  }
  const key = inputValue.slice(0, separatorIndex).trim()
  const value = inputValue.slice(separatorIndex + 1)
  if (!key) {
    throw new Error(`Expected --${flagName} to include a non-empty key.`)
  }
  return { key, value }
}

function coerceCliScalar(rawValue: string): unknown {
  const trimmed = rawValue.trim()
  if (!trimmed) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch {
      return rawValue
    }
  }
  return rawValue
}

function mergeArgValue(target: Record<string, unknown>, key: string, value: unknown): void {
  const current = target[key]
  if (current == null) {
    target[key] = value
    return
  }
  if (Array.isArray(current)) {
    current.push(value)
    target[key] = current
    return
  }
  target[key] = [current, value]
}

function inferContentTypeFromFilename(filename: string): string {
  const normalized = filename.toLowerCase()
  if (normalized.endsWith('.tar.gz') || normalized.endsWith('.tgz')) {
    return 'application/gzip'
  }

  switch (path.extname(normalized)) {
    case '.zip':
      return 'application/zip'
    case '.gz':
      return 'application/gzip'
    case '.tar':
      return 'application/x-tar'
    case '.txt':
    case '.log':
      return 'text/plain'
    case '.json':
      return 'application/json'
    case '.md':
      return 'text/markdown'
    case '.diff':
    case '.patch':
      return 'text/x-diff'
    case '.csv':
      return 'text/csv'
    case '.html':
      return 'text/html'
    case '.xml':
      return 'application/xml'
    case '.yaml':
    case '.yml':
      return 'application/yaml'
    default:
      return 'application/octet-stream'
  }
}

function isExistingFile(filePath: string): boolean {
  try {
    return statSync(path.resolve(filePath)).isFile()
  } catch {
    return false
  }
}

function uniquifyAttachmentName(slot: string, originalName: string, usedNames: Set<string>): string {
  const baseName = originalName || `${slot}.bin`
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName)
    return baseName
  }

  const parsed = path.parse(baseName)
  const prefixBase = `${slot}-${parsed.name}${parsed.ext}`
  if (!usedNames.has(prefixBase)) {
    usedNames.add(prefixBase)
    return prefixBase
  }

  let counter = 2
  while (true) {
    const candidate = `${slot}-${parsed.name}-${counter}${parsed.ext}`
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate)
      return candidate
    }
    counter += 1
  }
}

async function createAttachmentFromFile(slot: string, filePath: string, usedNames: Set<string>): Promise<{
  input: { slot: string; attachmentName: string }
  attachment: AampAttachment
}> {
  const resolvedPath = path.resolve(filePath)
  if (!isExistingFile(resolvedPath)) {
    throw new Error(`Attachment slot ${slot} points to a missing file: ${filePath}`)
  }

  const filename = uniquifyAttachmentName(slot, path.basename(resolvedPath), usedNames)
  const content = await readFile(resolvedPath)
  return {
    input: { slot, attachmentName: filename },
    attachment: {
      filename,
      content,
      contentType: inferContentTypeFromFilename(filename),
    },
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
  const slug = normalizeSlugInput(slugInput)
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

function getNodeName(args: ParsedArgs): string {
  return firstArg(args, 'node') ?? DEFAULT_NODE_NAME
}

async function mailboxConfigFromArgs(args: ParsedArgs): Promise<NodeConfig['mailbox']> {
  const nodeName = getNodeName(args)
  const mailboxProfile = firstArg(args, 'mailbox-profile')
  if (mailboxProfile) {
    const profile = await loadProfile(mailboxProfile)
    return {
      email: profile.email,
      smtpPassword: profile.smtpPassword,
      baseUrl: profile.baseUrl,
      smtpHost: profile.smtpHost,
      smtpPort: profile.smtpPort,
      rejectUnauthorized: profile.rejectUnauthorized,
    }
  }

  const explicitEmail = firstArg(args, 'email')
  if (explicitEmail) {
    const smtpPassword = firstArg(args, 'password') ?? firstArg(args, 'smtp-password') ?? await prompt('Mailbox password')
    const inferred = deriveServiceDefaults(explicitEmail)
    return {
      email: explicitEmail,
      smtpPassword,
      baseUrl: firstArg(args, 'base-url') ?? inferred.baseUrl,
      smtpHost: firstArg(args, 'smtp-host') ?? inferred.smtpHost,
      smtpPort: Number(firstArg(args, 'smtp-port') ?? '587'),
      rejectUnauthorized: (firstArg(args, 'reject-unauthorized') ?? 'true') !== 'false',
    }
  }

  if (existsSync(getNodeConfigPath(nodeName))) {
    const existingNode = await loadNodeConfig(nodeName)
    return existingNode.mailbox
  }

  const cachedProfile = await tryLoadProfile(DEFAULT_PROFILE)
  if (cachedProfile) {
    return {
      email: cachedProfile.email,
      smtpPassword: cachedProfile.smtpPassword,
      baseUrl: cachedProfile.baseUrl,
      smtpHost: cachedProfile.smtpHost,
      smtpPort: cachedProfile.smtpPort,
      rejectUnauthorized: cachedProfile.rejectUnauthorized,
    }
  }

  const shouldRegister = await promptYesNo('No cached mailbox found. Auto-register a new AAMP identity?', true)
  if (!shouldRegister) {
    throw new Error('Node init requires mailbox credentials or auto-registration.')
  }

  const host = firstArg(args, 'host') ?? await prompt('AAMP host', DEFAULT_BASE_URL)
  const slugInput = firstArg(args, 'slug') ?? await prompt('Mailbox slug', nodeName === DEFAULT_NODE_NAME ? 'local-node' : nodeName)
  const slug = normalizeSlugInput(slugInput)
  if (slug.length < 2) {
    throw new Error('Mailbox slug must be at least 2 characters')
  }

  const identity = await AampClient.registerMailbox({
    aampHost: host,
    slug,
    description: `Registered via aamp-cli node init (${nodeName})`,
  })
  const inferred = deriveServiceDefaults(identity.email)
  await saveProfile(DEFAULT_PROFILE, {
    email: identity.email,
    smtpPassword: identity.smtpPassword,
    baseUrl: identity.baseUrl,
    smtpHost: inferred.smtpHost,
    smtpPort: 587,
    rejectUnauthorized: true,
  })
  console.log(`Registered new mailbox ${identity.email} and saved it to profile "${DEFAULT_PROFILE}"`)

  return {
    email: identity.email,
    smtpPassword: identity.smtpPassword,
    baseUrl: identity.baseUrl,
    smtpHost: inferred.smtpHost,
    smtpPort: 587,
    rejectUnauthorized: true,
  }
}

async function persistRegisteredCommand(nodeName: string, config: NodeConfig, command: RegisteredCommand): Promise<{ specPath: string }> {
  const nextCommands = config.commands.filter((item) => item.name !== command.name)
  nextCommands.push(command)
  config.commands = nextCommands
  await saveNodeConfig(nodeName, config)

  const specsDir = getNodeCommandSpecsDir(nodeName)
  await mkdir(specsDir, { recursive: true })
  const specPath = path.join(specsDir, `${command.name}.json`)
  await writeFile(specPath, `${JSON.stringify(command, null, 2)}\n`, 'utf8')
  return { specPath }
}

async function createClientForNodeCall(args: ParsedArgs): Promise<RegisteredCommandSender> {
  const profileName = firstArg(args, 'profile')
  if (profileName) {
    return createClient(await loadProfile(profileName)) as RegisteredCommandSender
  }

  const nodeName = getNodeName(args)
  if (existsSync(getNodeConfigPath(nodeName))) {
    const config = await loadNodeConfig(nodeName)
    return AampClient.fromMailboxIdentity(config.mailbox) as RegisteredCommandSender
  }

  const cachedProfile = await tryLoadProfile(DEFAULT_PROFILE)
  if (cachedProfile) {
    return createClient(cachedProfile) as RegisteredCommandSender
  }

  throw new Error('No sender identity found. Run "aamp-cli node init" or "aamp-cli login" first.')
}

async function buildRegisteredCommandOptionsFromCli(args: ParsedArgs): Promise<NodeCallOptions> {
  const reservedKeys = new Set([
    'node',
    'profile',
    'target',
    'to',
    'command',
    'title',
    'stream',
    'task-id',
    'priority',
    'expires-at',
    'context-link',
    'dispatch-context',
    'arg',
    'attachment',
  ])

  const command = requireArg(args, 'command')
  const directArgs: Record<string, unknown> = {}
  const dispatchContext: Record<string, string> = {}
  const attachments: AampAttachment[] = []
  const inputs: NonNullable<NodeCallOptions['inputs']> = []
  const usedInputSlots = new Set<string>()
  const usedAttachmentNames = new Set<string>()

  const appendAttachment = async (slot: string, filePath: string): Promise<void> => {
    if (usedInputSlots.has(slot)) {
      throw new Error(`Attachment slot ${slot} was provided more than once.`)
    }
    const attachment = await createAttachmentFromFile(slot, filePath, usedAttachmentNames)
    usedInputSlots.add(slot)
    inputs.push(attachment.input)
    attachments.push(attachment.attachment)
  }

  for (const entry of allArgs(args, 'dispatch-context')) {
    const { key, value } = parseKeyValueEntry(entry, 'dispatch-context')
    dispatchContext[key] = value
  }

  for (const entry of allArgs(args, 'arg')) {
    const { key, value } = parseKeyValueEntry(entry, 'arg')
    mergeArgValue(directArgs, key, coerceCliScalar(value))
  }

  for (const entry of allArgs(args, 'attachment')) {
    const { key, value } = parseKeyValueEntry(entry, 'attachment')
    await appendAttachment(key, value)
  }

  for (const [key, values] of Object.entries(args.values)) {
    if (reservedKeys.has(key)) continue
    for (const value of values) {
      if (isExistingFile(value)) {
        await appendAttachment(key, value)
        continue
      }
      mergeArgValue(directArgs, key, coerceCliScalar(value))
    }
  }

  for (const key of args.booleans) {
    if (reservedKeys.has(key)) continue
    mergeArgValue(directArgs, key, true)
  }

  return {
    to: firstArg(args, 'target') ?? requireArg(args, 'to'),
    command,
    title: firstArg(args, 'title') ?? `Registered command: ${command}`,
    taskId: firstArg(args, 'task-id'),
    priority: firstArg(args, 'priority') as NodeCallOptions['priority'] | undefined,
    expiresAt: firstArg(args, 'expires-at'),
    contextLinks: allArgs(args, 'context-link'),
    ...(Object.keys(dispatchContext).length ? { dispatchContext } : {}),
    ...(Object.keys(directArgs).length ? { args: directArgs } : {}),
    ...(inputs.length ? { inputs } : {}),
    ...(attachments.length ? { attachments } : {}),
    streamMode: (firstArg(args, 'stream') as NodeCallOptions['streamMode'] | undefined) ?? 'full',
  }
}

async function buildInteractiveCommandSpec(nodeName: string): Promise<RegisteredCommand> {
  const templateInput = await prompt('Command template', 'git apply [patch_file]')
  const template = parseCommandTemplate(templateInput)
  const resolvedExec = resolveExecutableOnPath(template.executableToken)
  const exec = await prompt('Executable path', resolvedExec ?? template.executableToken)
  const defaultName = deriveCommandName(template, exec)
  const name = await prompt('Command name', defaultName)
  const description = await prompt('Description', '')
  const workingDirectory = path.resolve(await prompt('Working directory', process.cwd()))
  const timeoutMs = Number(await prompt('Timeout (ms)', '30000'))
  const maxStdoutBytes = Number(await prompt('Max stdout bytes', '65536'))
  const maxStderrBytes = Number(await prompt('Max stderr bytes', '65536'))

  const argsTemplate: string[] = []
  const properties: NonNullable<NonNullable<RegisteredCommand['argSchema']>['properties']> = {}
  const required: string[] = []
  const pathArgs: string[] = []
  const attachments: NonNullable<RegisteredCommand['attachments']> = {}

  for (const token of template.tokens) {
    if (token.kind === 'literal') {
      argsTemplate.push(token.value)
      continue
    }

    const defaultKind = /file|patch|attachment/i.test(token.value) ? 'file' : 'string'
    const kind = (await prompt(`Parameter "${token.value}" kind [string/file]`, defaultKind)).toLowerCase()
    if (kind === 'file') {
      const maxBytes = Number(await prompt(`Attachment "${token.value}" max bytes`, '2097152'))
      const contentTypesRaw = await prompt(`Attachment "${token.value}" content types (comma-separated)`, 'application/octet-stream,text/plain')
      attachments[token.value] = {
        required: true,
        maxBytes,
        contentTypes: contentTypesRaw.split(',').map((item) => item.trim()).filter(Boolean),
      }
      argsTemplate.push(`{{inputs.${token.value}.path}}`)
      continue
    }

    properties[token.value] = { type: 'string' }
    required.push(token.value)
    const constrainedPath = await promptYesNo(`Should "${token.value}" be treated as a path constrained to the working directory?`, /path|file|dir/i.test(token.value))
    if (constrainedPath) {
      pathArgs.push(token.value)
    }
    argsTemplate.push(`{{args.${token.value}}}`)
  }

  const command: RegisteredCommand = {
    name,
    ...(description ? { description } : {}),
    exec,
    argsTemplate,
    workingDirectory,
    ...(pathArgs.length ? { pathArgs } : {}),
    ...(required.length ? {
      argSchema: {
        type: 'object',
        required,
        additionalProperties: false,
        properties,
      },
    } : {}),
    ...(Object.keys(attachments).length ? { attachments } : {}),
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    enabled: true,
  }

  console.log(JSON.stringify({ node: nodeName, generatedCommand: command }, null, 2))
  const shouldSave = await promptYesNo('Register this command?', true)
  if (!shouldSave) {
    throw new Error('Command registration cancelled.')
  }
  return command
}

export async function runNodeInit(args: ParsedArgs): Promise<void> {
  const nodeName = getNodeName(args)
  const config = createDefaultNodeConfig(await mailboxConfigFromArgs(args))
  const file = await saveNodeConfig(nodeName, config)
  console.log(JSON.stringify({
    node: nodeName,
    savedTo: file,
    mailbox: config.mailbox.email,
    summary: createNodeConfigSummary(config),
  }, null, 2))
}

async function runNodeShow(args: ParsedArgs): Promise<void> {
  const nodeName = getNodeName(args)
  const config = await loadNodeConfig(nodeName)
  console.log(JSON.stringify({
    node: nodeName,
    path: getNodeConfigPath(nodeName),
    config,
  }, null, 2))
}

export async function runNodeCall(args: ParsedArgs): Promise<void> {
  const client = await createClientForNodeCall(args)
  const payload = await buildRegisteredCommandOptionsFromCli(args)
  const result = await client.sendRegisteredCommand(payload)
  console.log(JSON.stringify({
    ...result,
    to: payload.to,
    command: payload.command,
    title: payload.title,
    args: payload.args ?? {},
    inputs: payload.inputs ?? [],
  }, null, 2))
}

async function runNodeCommandList(args: ParsedArgs): Promise<void> {
  const nodeName = getNodeName(args)
  const config = await loadNodeConfig(nodeName)
  console.log(JSON.stringify({
    node: nodeName,
    commands: config.commands,
  }, null, 2))
}

export async function runNodeCommandAdd(args: ParsedArgs): Promise<void> {
  const nodeName = getNodeName(args)
  const config = await loadNodeConfig(nodeName)
  const specFile = firstArg(args, 'spec-file')
  let command: RegisteredCommand
  if (specFile) {
    command = JSON.parse(await readFile(specFile, 'utf8')) as RegisteredCommand
    if (!command.name || !command.exec || !command.workingDirectory || !Array.isArray(command.argsTemplate)) {
      throw new Error('Command spec must include name, exec, workingDirectory, and argsTemplate.')
    }
  } else {
    command = await buildInteractiveCommandSpec(nodeName)
  }
  const { specPath } = await persistRegisteredCommand(nodeName, config, command)
  console.log(`Registered command "${command.name}" on node "${nodeName}"`)
  console.log(`Saved command spec to ${specPath}`)
}

async function runNodeCommandRemove(args: ParsedArgs): Promise<void> {
  const nodeName = getNodeName(args)
  const commandName = requireArg(args, 'command')
  const config = await loadNodeConfig(nodeName)
  config.commands = config.commands.filter((item) => item.name !== commandName)
  await saveNodeConfig(nodeName, config)
  console.log(`Removed command "${commandName}" from node "${nodeName}"`)
}

function parseContextEntries(values: string[]): Record<string, string> {
  const entries: Record<string, string> = {}
  for (const value of values) {
    const [rawKey, ...rest] = value.split('=')
    const key = rawKey?.trim()
    const parsedValue = rest.join('=').trim()
    if (!key || !parsedValue) {
      throw new Error(`Invalid --require-context entry: ${value}`)
    }
    entries[key] = parsedValue
  }
  return entries
}

async function runNodePolicyShow(args: ParsedArgs): Promise<void> {
  const nodeName = getNodeName(args)
  const config = await loadNodeConfig(nodeName)
  console.log(JSON.stringify({
    node: nodeName,
    senderPolicy: config.senderPolicy,
  }, null, 2))
}

async function runNodePolicySet(args: ParsedArgs): Promise<void> {
  const nodeName = getNodeName(args)
  const config = await loadNodeConfig(nodeName)
  const defaultAction = firstArg(args, 'default-action')
  if (defaultAction === 'allow' || defaultAction === 'deny') {
    config.senderPolicy.defaultAction = defaultAction
  }
  if (args.booleans.has('clear-allow-from')) {
    config.senderPolicy.allowFrom = []
  } else if (allArgs(args, 'allow-from').length > 0) {
    config.senderPolicy.allowFrom = allArgs(args, 'allow-from')
  }
  if (args.booleans.has('clear-allow-command')) {
    config.senderPolicy.allowCommands = []
  } else if (allArgs(args, 'allow-command').length > 0) {
    config.senderPolicy.allowCommands = allArgs(args, 'allow-command')
  }
  if (args.booleans.has('clear-require-context')) {
    config.senderPolicy.requireContext = {}
  } else if (allArgs(args, 'require-context').length > 0) {
    config.senderPolicy.requireContext = parseContextEntries(allArgs(args, 'require-context'))
  }
  await saveNodeConfig(nodeName, config)
  console.log(JSON.stringify({
    node: nodeName,
    senderPolicy: config.senderPolicy,
  }, null, 2))
}

async function runNodeSyncCard(args: ParsedArgs): Promise<void> {
  const nodeName = getNodeName(args)
  const config = await loadNodeConfig(nodeName)
  const client = createClient(config.mailbox)
  const summary = createNodeConfigSummary(config)
  const cardText = buildNodeCapabilityCard(config)
  const profile = await client.updateDirectoryProfile({ summary, cardText })
  console.log(JSON.stringify({
    node: nodeName,
    profile,
  }, null, 2))
}

async function runNode(args: ParsedArgs): Promise<void> {
  const subcommand = args.positionals[0] ?? 'help'
  if (subcommand === 'help') {
    printNodeUsage()
    return
  }

  if (subcommand === 'init') {
    await runNodeInit(args)
    return
  }
  if (subcommand === 'show') {
    await runNodeShow(args)
    return
  }
  if (subcommand === 'serve') {
    const nodeName = getNodeName(args)
    const config = await loadNodeConfig(nodeName)
    await runNodeServe(nodeName, config)
    return
  }
  if (subcommand === 'sync-card') {
    await runNodeSyncCard(args)
    return
  }
  if (subcommand === 'call') {
    await runNodeCall(args)
    return
  }
  if (subcommand === 'command') {
    const action = args.positionals[1] ?? 'help'
    if (action === 'list') {
      await runNodeCommandList(args)
      return
    }
    if (action === 'add') {
      await runNodeCommandAdd(args)
      return
    }
    if (action === 'remove') {
      await runNodeCommandRemove(args)
      return
    }
    printNodeUsage()
    return
  }
  if (subcommand === 'policy') {
    const action = args.positionals[1] ?? 'help'
    if (action === 'show') {
      await runNodePolicyShow(args)
      return
    }
    if (action === 'set') {
      await runNodePolicySet(args)
      return
    }
    printNodeUsage()
    return
  }

  printNodeUsage()
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
    case 'node':
      await runNode(args)
      return
    default:
      printUsage()
  }
}

function resolveDirectRunCandidate(entryPath: string | undefined): string | null {
  if (!entryPath) return null
  try {
    return pathToFileURL(realpathSync(entryPath)).href
  } catch {
    return pathToFileURL(entryPath).href
  }
}

const isDirectRun = import.meta.url === resolveDirectRunCandidate(process.argv[1])

if (isDirectRun) {
  main().catch((err) => {
    console.error(`[aamp-cli] ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
