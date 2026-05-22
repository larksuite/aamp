import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  AampClient,
  type AampAttachment,
  type AampThreadEvent,
  type AampStreamEvent,
  type PairRequest,
  type ReceivedAttachment,
  type SendPairRespondOptions,
  type SendResultOptions,
  type StructuredResultField,
  type TaskCancel,
  type TaskDispatch,
} from 'aamp-sdk'
import {
  type NodeConfig,
  type RegisteredAttachmentSlot,
  type RegisteredCommand,
  getNodeStateDir,
  saveNodeConfig,
} from './node-config.js'

export interface RegisteredCommandDispatchPayload {
  kind: 'registered-command/v1'
  command: string
  args?: Record<string, unknown>
  inputs?: Array<{
    slot: string
    attachmentName: string
  }>
  stream?: {
    mode?: 'none' | 'status-only' | 'full'
  }
}

interface RegisteredCommandResultPayload {
  kind: 'registered-command-result/v1'
  command: string
  status: 'completed' | 'rejected'
  exitCode: number | null
  summary: string
  stdout?: string
  stderr?: string
  truncated: {
    stdout: boolean
    stderr: boolean
  }
  attachments?: Array<{
    name: string
    contentType: string
  }>
  structuredResult?: StructuredResultField[]
  timing: {
    startedAt: string
    finishedAt: string
    durationMs: number
  }
}

const STRUCTURED_RESULT_MARKER = 'AAMP_RESULT_JSON:'

type StreamMode = 'none' | 'status-only' | 'full'

type JsonPrimitive = string | number | boolean | null

interface DownloadedInput {
  slot: string
  originalFilename: string
  savedPath: string
  relativePath: string
  contentType: string
  size: number
}

interface LedgerEntry {
  taskId: string
  command: string
  from: string
  status: 'running' | 'completed' | 'rejected' | 'cancelled' | 'interrupted' | 'expired'
  messageId: string
  updatedAt: string
}

interface LedgerState {
  version: 1
  tasks: Record<string, LedgerEntry>
}

interface ActiveTask {
  taskId: string
  child: ChildProcessWithoutNullStreams
  streamId?: string
  cancelled: boolean
  cancelTimer?: NodeJS.Timeout
  dispatch: TaskDispatch
  command: RegisteredCommand
}

interface LoggerLike {
  log(message: string): void
  error(message: string): void
}

export interface NodeServeOptions {
  quiet?: boolean
}

interface AampNodeClient {
  on(event: 'task.dispatch', handler: (task: TaskDispatch) => void): void
  on(event: 'task.cancel', handler: (task: TaskCancel) => void): void
  on(event: 'pair.request', handler: (request: PairRequest) => void): void
  on(event: 'connected', handler: () => void): void
  on(event: 'disconnected', handler: (reason: string) => void): void
  on(event: 'error', handler: (error: Error) => void): void
  connect(): Promise<void>
  disconnect(): void
  isUsingPollingFallback(): boolean
  reconcileRecentEmails(limit?: number, opts?: { includeHistorical?: boolean }): Promise<number>
  createStream(opts: { taskId: string; peerEmail: string }): Promise<{ streamId: string }>
  sendStreamOpened(opts: { to: string; taskId: string; streamId: string; inReplyTo?: string }): Promise<void>
  appendStreamEvent(opts: { streamId: string; type: AampStreamEvent['type']; payload: Record<string, unknown> }): Promise<AampStreamEvent>
  closeStream(opts: { streamId: string; payload?: Record<string, unknown> }): Promise<unknown>
  downloadBlob(blobId: string, filename?: string): Promise<Buffer>
  getThreadHistory(taskId: string, opts?: { includeStreamOpened?: boolean }): Promise<{ taskId: string; events: AampThreadEvent[] }>
  sendResult(opts: SendResultOptions & { rawBodyText?: string }): Promise<void>
  sendPairRespond(opts: SendPairRespondOptions): Promise<void>
  email: string
}

const LEDGER_FILENAME = 'ledger.json'

function ensureJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return value as Record<string, unknown>
}

function formatTransport(client: { isUsingPollingFallback(): boolean }): string {
  return client.isUsingPollingFallback() ? 'polling fallback' : 'websocket'
}

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'item'
}

function matchesSenderPattern(senderEmail: string, pattern: string): boolean {
  const normalizedSender = senderEmail.trim().toLowerCase()
  const normalizedPattern = pattern.trim().toLowerCase()
  if (!normalizedSender || !normalizedPattern) return false

  const canonicalPattern = normalizedPattern.startsWith('@')
    ? `*${normalizedPattern}`
    : normalizedPattern

  const escaped = canonicalPattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i').test(normalizedSender)
}

function isPrimitive(value: unknown): value is JsonPrimitive {
  return value == null || ['string', 'number', 'boolean'].includes(typeof value)
}

function validateAgainstSchema(
  value: unknown,
  schema: RegisteredCommand['argSchema'],
  location = 'args',
): string[] {
  if (!schema) return []
  const errors: string[] = []

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [`${location} must be an object`]
    }
    const objectValue = value as Record<string, unknown>
    for (const key of schema.required ?? []) {
      if (!(key in objectValue)) {
        errors.push(`${location}.${key} is required`)
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (!(key in objectValue)) continue
      errors.push(...validateAgainstSchema(objectValue[key], child, `${location}.${key}`))
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}))
      for (const key of Object.keys(objectValue)) {
        if (!allowed.has(key)) {
          errors.push(`${location}.${key} is not allowed`)
        }
      }
    }
    return errors
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${location} must be an array`]
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(item, schema.items, `${location}[${index}]`))
      })
    }
    return errors
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') return [`${location} must be a string`]
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return [`${location} must be a number`]
  } else if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') return [`${location} must be a boolean`]
  }

  if (schema.enum && !schema.enum.includes(value as never)) {
    errors.push(`${location} must be one of: ${schema.enum.join(', ')}`)
  }

  return errors
}

function extractJsonBody(bodyText: string): string {
  const trimmed = bodyText.trim()
  if (!trimmed) throw new Error('Task body is empty; expected JSON payload.')
  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    const firstBrace = trimmed.indexOf('{')
    const lastBrace = trimmed.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1)
      JSON.parse(candidate)
      return candidate
    }
    throw new Error('Task body is not valid JSON.')
  }
}

export function parseRegisteredCommandPayload(bodyText: string): RegisteredCommandDispatchPayload {
  const parsed = JSON.parse(extractJsonBody(bodyText)) as RegisteredCommandDispatchPayload
  if (parsed.kind !== 'registered-command/v1') {
    throw new Error(`Unsupported payload kind: ${String(parsed.kind ?? '') || 'missing kind'}`)
  }
  if (!parsed.command || typeof parsed.command !== 'string') {
    throw new Error('Payload command must be a non-empty string.')
  }
  if (parsed.args != null && (typeof parsed.args !== 'object' || Array.isArray(parsed.args))) {
    throw new Error('Payload args must be an object when provided.')
  }
  if (parsed.inputs != null && !Array.isArray(parsed.inputs)) {
    throw new Error('Payload inputs must be an array when provided.')
  }
  return parsed
}

async function normalizeArgsForCommand(
  command: RegisteredCommand,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const normalized: Record<string, unknown> = { ...args }

  for (const key of command.pathArgs ?? []) {
    if (!(key in normalized)) continue
    const value = normalized[key]
    if (typeof value === 'string') {
      normalized[key] = await resolvePathInsideWorkdirAsync(command.workingDirectory, value)
      continue
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      normalized[key] = await Promise.all(value.map((item) => resolvePathInsideWorkdirAsync(command.workingDirectory, item)))
      continue
    }
    throw new Error(`Path argument "${key}" must be a string or string array.`)
  }

  return normalized
}

async function resolvePathInsideWorkdirAsync(workingDirectory: string, rawValue: string): Promise<string> {
  if (!rawValue.trim()) {
    throw new Error('Path arguments cannot be empty.')
  }
  if (path.isAbsolute(rawValue)) {
    throw new Error(`Absolute paths are not allowed: ${rawValue}`)
  }

  const normalized = path.normalize(rawValue)
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`Path escapes working directory: ${rawValue}`)
  }

  const resolved = path.resolve(workingDirectory, normalized)
  const relative = path.relative(workingDirectory, resolved)
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`Path escapes working directory: ${rawValue}`)
  }

  const existingPath = existsSync(resolved) ? resolved : existsSync(path.dirname(resolved)) ? path.dirname(resolved) : null
  if (!existingPath) {
    return normalized === '.' ? '.' : relative || '.'
  }

  const realExistingPath = await realpath(existingPath).catch(() => existingPath)
  const effectivePath = existingPath === resolved
    ? realExistingPath
    : path.join(realExistingPath, path.basename(resolved))
  const effectiveRelative = path.relative(workingDirectory, effectivePath)
  if (effectiveRelative === '..' || effectiveRelative.startsWith(`..${path.sep}`)) {
    throw new Error(`Path escapes working directory via symlink: ${rawValue}`)
  }
  return normalized === '.' ? '.' : effectiveRelative || '.'
}

function placeholderValues(
  token: string,
  args: Record<string, unknown>,
  inputs: Record<string, DownloadedInput>,
): string[] | null {
  const argMatch = /^\{\{args\.([a-zA-Z0-9_-]+)\}\}$/.exec(token)
  if (argMatch?.[1]) {
    const value = args[argMatch[1]]
    if (Array.isArray(value)) {
      if (!value.every(isPrimitive)) {
        throw new Error(`Argument ${argMatch[1]} contains unsupported array values.`)
      }
      return value.map((item) => String(item))
    }
    if (!isPrimitive(value)) {
      throw new Error(`Argument ${argMatch[1]} contains an unsupported value.`)
    }
    return [String(value)]
  }

  const inputMatch = /^\{\{inputs\.([a-zA-Z0-9_-]+)\.path\}\}$/.exec(token)
  if (inputMatch?.[1]) {
    const input = inputs[inputMatch[1]]
    if (!input) {
      throw new Error(`Input slot ${inputMatch[1]} is not available.`)
    }
    return [input.relativePath]
  }

  return null
}

function renderArgsTemplate(
  template: string[],
  args: Record<string, unknown>,
  inputs: Record<string, DownloadedInput>,
): string[] {
  const argv: string[] = []
  for (const token of template) {
    const values = placeholderValues(token, args, inputs)
    if (values) {
      argv.push(...values)
      continue
    }
    argv.push(token)
  }
  return argv
}

function buildCommandEnvironment(command: RegisteredCommand): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(command.environment ?? {}),
  }
}

async function readJsonFile<T>(file: string, fallback: T): Promise<T> {
  if (!existsSync(file)) return fallback
  const raw = await readFile(file, 'utf8')
  return JSON.parse(raw) as T
}

async function writeJsonFile(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const tempFile = `${file}.${process.pid}.tmp`
  await writeFile(tempFile, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tempFile, file)
}

function ledgerFilePath(nodeName: string): string {
  return path.join(getNodeStateDir(nodeName), LEDGER_FILENAME)
}

function staleRunningToInterrupted(state: LedgerState): LedgerState {
  const tasks = Object.fromEntries(
    Object.entries(state.tasks ?? {}).map(([taskId, entry]) => [
      taskId,
      entry.status === 'running'
        ? {
          ...entry,
          status: 'interrupted' as const,
          updatedAt: new Date().toISOString(),
        }
        : entry,
    ]),
  )
  return { version: 1, tasks }
}

async function loadLedger(nodeName: string): Promise<LedgerState> {
  const state = await readJsonFile<LedgerState>(ledgerFilePath(nodeName), {
    version: 1,
    tasks: {},
  })
  return staleRunningToInterrupted(state)
}

async function ensureRunDirectory(command: RegisteredCommand, taskId: string): Promise<string> {
  const runDir = path.join(command.workingDirectory, '.aamp-cli', 'runs', sanitizeName(taskId))
  await rm(runDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(path.join(runDir, 'inputs'), { recursive: true })
  return runDir
}

function matchAttachmentByName(
  available: ReceivedAttachment[],
  attachmentName: string,
): ReceivedAttachment | undefined {
  return available.find((attachment) => attachment.filename === attachmentName)
}

function normalizeContentType(value: string | undefined): string {
  return (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? ''
}

const ZIP_CONTENT_TYPE_ALIASES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'multipart/x-zip',
])

const TAR_GZ_CONTENT_TYPE_ALIASES = new Set([
  'application/gzip',
  'application/x-gzip',
  'application/x-gtar',
  'application/x-tar',
  'application/x-compressed-tar',
  'application/tar+gzip',
  'application/tgz',
])

function contentTypeMatchesAllowed(actual: string, allowed: string): boolean {
  const normalizedActual = normalizeContentType(actual)
  const normalizedAllowed = normalizeContentType(allowed)
  if (!normalizedActual || !normalizedAllowed) return false
  if (normalizedActual === normalizedAllowed) return true
  if (ZIP_CONTENT_TYPE_ALIASES.has(normalizedActual) && ZIP_CONTENT_TYPE_ALIASES.has(normalizedAllowed)) {
    return true
  }
  if (
    TAR_GZ_CONTENT_TYPE_ALIASES.has(normalizedActual)
    && TAR_GZ_CONTENT_TYPE_ALIASES.has(normalizedAllowed)
  ) {
    return true
  }
  return false
}

function validateAttachmentAgainstSlot(
  attachment: ReceivedAttachment,
  slot: RegisteredAttachmentSlot,
  slotName: string,
): void {
  if (slot.maxBytes != null && attachment.size > slot.maxBytes) {
    throw new Error(`Attachment ${attachment.filename} exceeds maxBytes for slot ${slotName}.`)
  }
  if (slot.contentTypes?.length && !slot.contentTypes.some((allowed) => contentTypeMatchesAllowed(attachment.contentType, allowed))) {
    throw new Error(`Attachment ${attachment.filename} has unsupported content type "${attachment.contentType}" for slot ${slotName}. Allowed: ${slot.contentTypes.join(', ')}`)
  }
}

async function downloadInputs(
  client: AampNodeClient,
  command: RegisteredCommand,
  payload: RegisteredCommandDispatchPayload,
  dispatch: TaskDispatch,
  runDir: string,
): Promise<Record<string, DownloadedInput>> {
  const attachmentDefinitions = command.attachments ?? {}
  const attachmentRefs = payload.inputs ?? []
  const available = dispatch.attachments ?? []
  const inputs: Record<string, DownloadedInput> = {}

  for (const [slotName, slotConfig] of Object.entries(attachmentDefinitions)) {
    if (slotConfig.required && !attachmentRefs.some((item) => item.slot === slotName)) {
      throw new Error(`Required attachment slot ${slotName} was not provided.`)
    }
  }

  for (const ref of attachmentRefs) {
    if (!ref?.slot || !ref.attachmentName) {
      throw new Error('Each input entry must include slot and attachmentName.')
    }
    const slotConfig = attachmentDefinitions[ref.slot]
    if (!slotConfig) {
      throw new Error(`Input slot ${ref.slot} is not registered for command ${command.name}.`)
    }
    if (inputs[ref.slot]) {
      throw new Error(`Input slot ${ref.slot} was provided more than once.`)
    }

    const attachment = matchAttachmentByName(available, ref.attachmentName)
    if (!attachment) {
      throw new Error(`Attachment ${ref.attachmentName} was not found in the dispatch.`)
    }

    validateAttachmentAgainstSlot(attachment, slotConfig, ref.slot)

    const buffer = await client.downloadBlob(attachment.blobId, attachment.filename)
    const safeFilename = `${sanitizeName(ref.slot)}-${sanitizeName(attachment.filename)}`
    const absolutePath = path.join(runDir, 'inputs', safeFilename)
    await writeFile(absolutePath, buffer)
    inputs[ref.slot] = {
      slot: ref.slot,
      originalFilename: attachment.filename,
      savedPath: absolutePath,
      relativePath: path.relative(command.workingDirectory, absolutePath) || path.basename(absolutePath),
      contentType: attachment.contentType,
      size: attachment.size,
    }
  }

  return inputs
}

function streamModeFromPayload(payload: RegisteredCommandDispatchPayload): StreamMode {
  return payload.stream?.mode ?? 'full'
}

function decidePolicy(
  config: NodeConfig,
  dispatch: TaskDispatch,
  command: RegisteredCommand,
): { allowed: boolean; reason?: string } {
  const policy = config.senderPolicy
  const pairedDecision = decidePairedSenderPolicy(policy.pairedSenders ?? [], dispatch)
  if (pairedDecision.allowed) return pairedDecision

  const senderAllowed = policy.allowFrom.length === 0
    ? true
    : policy.allowFrom.some((pattern) => matchesSenderPattern(dispatch.from, pattern))
  const commandAllowed = policy.allowCommands.length === 0
    ? true
    : policy.allowCommands.includes(command.name)

  if (policy.allowFrom.length === 0 && policy.allowCommands.length === 0 && policy.defaultAction === 'deny') {
    return { allowed: false, reason: 'Sender policy defaultAction=deny and no explicit allow rules matched.' }
  }

  if (!senderAllowed) {
    return {
      allowed: false,
      reason: `Sender policy rejected ${dispatch.from}. Allowed senders: ${policy.allowFrom.join(', ')}`,
    }
  }

  if (!commandAllowed) {
    return {
      allowed: false,
      reason: `Sender policy rejected command ${command.name}. Allowed commands: ${policy.allowCommands.join(', ')}`,
    }
  }

  for (const [key, expectedValue] of Object.entries(policy.requireContext ?? {})) {
    const actualValue = dispatch.dispatchContext?.[key]?.trim()
    if (actualValue !== expectedValue) {
      return {
        allowed: false,
        reason: `Sender policy requires X-AAMP-Dispatch-Context ${key}=${expectedValue}.`,
      }
    }
  }

  return { allowed: true }
}

function decidePairedSenderPolicy(
  pairedSenders: NodeConfig['senderPolicy']['pairedSenders'],
  dispatch: TaskDispatch,
): { allowed: boolean; reason?: string } {
  if (pairedSenders.length === 0) return { allowed: false, reason: 'no paired sender policy configured' }

  const sender = normalizeEmail(dispatch.from)
  const policy = pairedSenders.find((item) => normalizeEmail(item.sender) === sender)
  if (!policy) return { allowed: false, reason: `sender ${dispatch.from} is not paired` }

  for (const [key, allowedValues] of Object.entries(policy.dispatchContextRules ?? {})) {
    if (!Array.isArray(allowedValues) || allowedValues.length === 0) continue
    const actual = dispatch.dispatchContext?.[key]
    if (!actual || !allowedValues.includes(actual)) {
      return { allowed: false, reason: `dispatchContext does not match paired sender policy for ${dispatch.from}` }
    }
  }

  return { allowed: true }
}

function summarizeExit(commandName: string, exitCode: number | null, cancelled: boolean): string {
  if (cancelled) return `Command ${commandName} was cancelled.`
  if (exitCode === 0) return `Command ${commandName} completed successfully.`
  return `Command ${commandName} exited with code ${exitCode ?? 'unknown'}.`
}

function createResultBody(payload: RegisteredCommandResultPayload): string {
  return `${JSON.stringify(payload, null, 2)}\n`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeStructuredResultField(value: unknown): StructuredResultField | null {
  const record = asRecord(value)
  if (!record) return null

  const fieldKey = asString(record.fieldKey)
  const fieldTypeKey = asString(record.fieldTypeKey)
  const fieldAlias = asString(record.fieldAlias)
  const index = asString(record.index)
  const attachmentFilenames = Array.isArray(record.attachmentFilenames)
    && record.attachmentFilenames.every((item) => typeof item === 'string')
    ? record.attachmentFilenames
    : undefined
  const hasValue = Object.prototype.hasOwnProperty.call(record, 'value')

  if (!fieldKey && !fieldTypeKey && !fieldAlias && !index && !attachmentFilenames?.length && !hasValue) {
    return null
  }

  return {
    ...(fieldKey ? { fieldKey } : {}),
    ...(fieldTypeKey ? { fieldTypeKey } : {}),
    ...(hasValue ? { value: record.value } : {}),
    ...(fieldAlias ? { fieldAlias } : {}),
    ...(index ? { index } : {}),
    ...(attachmentFilenames ? { attachmentFilenames } : {}),
  } as StructuredResultField
}

function normalizeStructuredResult(value: unknown): StructuredResultField[] | undefined {
  if (!Array.isArray(value)) return undefined
  const fields = value
    .map((item) => normalizeStructuredResultField(item))
    .filter((item): item is StructuredResultField => item != null)
  return fields.length ? fields : undefined
}

function extractBalancedJsonRange(source: string): { jsonText: string; start: number; end: number } | null {
  const start = source.search(/[\[{]/)
  if (start < 0) return null

  const stack: string[] = []
  let inString = false
  let escaped = false

  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{' || char === '[') {
      stack.push(char)
      continue
    }
    if (char !== '}' && char !== ']') continue

    const opener = stack.pop()
    if ((char === '}' && opener !== '{') || (char === ']' && opener !== '[')) return null
    if (stack.length === 0) {
      return {
        jsonText: source.slice(start, i + 1),
        start,
        end: i + 1,
      }
    }
  }

  return null
}

function extractJsonFromMaybeFence(source: string): { jsonText: string; start: number; end: number } | null {
  const trimmedStart = source.search(/\S/)
  if (trimmedStart < 0) return null
  const body = source.slice(trimmedStart)
  const fenceMatch = /^```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(body)
  if (fenceMatch) {
    return {
      jsonText: fenceMatch[1].trim(),
      start: trimmedStart,
      end: trimmedStart + fenceMatch[0].length,
    }
  }

  return extractBalancedJsonRange(source)
}

function parseStructuredResultFromCommandOutput(stdout: string): StructuredResultField[] | undefined {
  const trimmed = stdout.trim()
  if (!trimmed) return undefined

  const markerIndex = trimmed.lastIndexOf(STRUCTURED_RESULT_MARKER)
  const source = markerIndex >= 0 ? trimmed.slice(markerIndex + STRUCTURED_RESULT_MARKER.length) : trimmed
  const jsonRange = extractJsonFromMaybeFence(source)
  if (!jsonRange) return undefined

  if (markerIndex < 0 && (jsonRange.start !== 0 || jsonRange.end !== source.length)) return undefined

  try {
    const parsed = JSON.parse(jsonRange.jsonText) as unknown
    const record = asRecord(parsed)
    return normalizeStructuredResult(
      Array.isArray(parsed) ? parsed : record?.structuredResult ?? record?.structured_result,
    )
  } catch {
    return undefined
  }
}

interface ExecutionBuffers {
  stdoutPreview: string
  stderrPreview: string
  stdoutBytes: number
  stderrBytes: number
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

function createExecutionBuffers(): ExecutionBuffers {
  return {
    stdoutPreview: '',
    stderrPreview: '',
    stdoutBytes: 0,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
  }
}

function normalizeEmail(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function isDispatchForThisNode(dispatch: TaskDispatch, clientEmail: string): boolean {
  return normalizeEmail(dispatch.to) === normalizeEmail(clientEmail)
}

function isSelfSentDispatch(dispatch: TaskDispatch, clientEmail: string): boolean {
  return normalizeEmail(dispatch.from) === normalizeEmail(clientEmail)
}

function isExpiredDispatch(dispatch: TaskDispatch, now = Date.now()): boolean {
  if (!dispatch.expiresAt) return false
  const expiresAtMs = new Date(dispatch.expiresAt).getTime()
  return Number.isFinite(expiresAtMs) && expiresAtMs < now
}

function hasTerminalThreadEvent(events: AampThreadEvent[], taskId: string): boolean {
  return events.some((event) => event.intent !== 'task.dispatch' && (
    event.intent === 'task.result'
    || event.intent === 'task.help_needed'
    || event.intent === 'task.cancel'
  ))
}

function appendPreview(
  current: string,
  chunk: Buffer,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current)
  if (currentBytes >= maxBytes) {
    return { text: current, truncated: true }
  }

  const remaining = maxBytes - currentBytes
  if (chunk.length <= remaining) {
    return { text: current + chunk.toString('utf8'), truncated: false }
  }

  return {
    text: current + chunk.subarray(0, remaining).toString('utf8'),
    truncated: true,
  }
}

async function createOutputAttachment(file: string, name: string): Promise<AampAttachment> {
  const content = await readFile(file)
  return {
    filename: name,
    contentType: 'text/plain',
    content,
    size: content.length,
  }
}

export class AampLocalNodeService {
  private readonly activeTasks = new Map<string, ActiveTask>()
  private readonly ledgerFile: string
  private ledger: LedgerState = { version: 1, tasks: {} }
  private quietStartup = false

  constructor(
    private readonly nodeName: string,
    private readonly config: NodeConfig,
    private readonly client: AampNodeClient,
    private readonly logger: LoggerLike = console,
    private readonly spawnProcess: typeof spawn = spawn,
  ) {
    this.ledgerFile = ledgerFilePath(nodeName)
  }

  async start(options: NodeServeOptions = {}): Promise<void> {
    this.quietStartup = options.quiet === true
    this.ledger = await loadLedger(this.nodeName)
    await writeJsonFile(this.ledgerFile, this.ledger)
    this.attachHandlers()
    await this.client.connect()
    if (!this.quietStartup) {
      this.logger.log(`[AAMP] node "${this.nodeName}" connected as ${this.client.email} (${formatTransport(this.client)})`)
    }
    const reconciled = await this.client.reconcileRecentEmails(50, { includeHistorical: true })
    if (!this.quietStartup) {
      this.logger.log(`[AAMP] node "${this.nodeName}" reconciled ${reconciled} recent email(s) on startup`)
    }
    this.quietStartup = false
  }

  stop(): void {
    for (const active of this.activeTasks.values()) {
      active.cancelled = true
      active.child.kill('SIGTERM')
      if (active.cancelTimer) clearTimeout(active.cancelTimer)
    }
    this.client.disconnect()
  }

  private attachHandlers(): void {
    this.client.on('connected', () => {
      if (!this.quietStartup) {
        this.logger.log(`[AAMP] node transport ready (${formatTransport(this.client)})`)
      }
    })
    this.client.on('disconnected', (reason) => {
      if (!this.quietStartup) {
        this.logger.log(`[AAMP] node disconnected: ${reason}`)
      }
    })
    this.client.on('error', (error) => {
      this.logger.error(`[AAMP] node error: ${error.message}`)
    })
    this.client.on('task.dispatch', (dispatch) => {
      void this.handleDispatch(dispatch).catch((error) => {
        this.logger.error(`[AAMP] dispatch ${dispatch.taskId} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    this.client.on('task.cancel', (cancel) => {
      void this.handleCancel(cancel).catch((error) => {
        this.logger.error(`[AAMP] cancel ${cancel.taskId} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
    this.client.on('pair.request', (request) => {
      void this.handlePairRequest(request).catch((error) => {
        this.logger.error(`[AAMP] pair.request failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    })
  }

  private async handlePairRequest(request: PairRequest): Promise<void> {
    if (normalizeEmail(request.to) !== normalizeEmail(this.client.email)) return

    const pairing = this.config.pairing
    if (!pairing || pairing.consumedAt || pairing.mailbox.toLowerCase() !== normalizeEmail(this.client.email)) {
      const reason = 'no active pairing code'
      this.logger.log(`[AAMP] rejected pair.request from ${request.from}: ${reason}`)
      await this.sendPairResponse(request, false, reason)
      return
    }
    if (pairing.pairCode !== request.pairCode || new Date(pairing.expiresAt).getTime() <= Date.now()) {
      const reason = 'invalid or expired pair code'
      this.logger.log(`[AAMP] rejected pair.request from ${request.from}: ${reason}`)
      await this.sendPairResponse(request, false, reason)
      return
    }

    const sender = normalizeEmail(request.from)
    const pairedSenders = this.config.senderPolicy.pairedSenders ?? []
    this.config.senderPolicy.pairedSenders = [
      ...pairedSenders.filter((item) => normalizeEmail(item.sender) !== sender),
      {
        sender,
        dispatchContextRules: request.dispatchContextRules ?? {},
        pairedAt: new Date().toISOString(),
      },
    ]
    await saveNodeConfig(this.nodeName, this.config)
    this.logger.log(`[AAMP] paired sender ${sender}; node config updated`)
    if (await this.sendPairResponse(request, true)) {
      this.config.pairing = {
        ...pairing,
        pairCode: '',
        consumedAt: new Date().toISOString(),
      }
      await saveNodeConfig(this.nodeName, this.config)
    } else {
      this.logger.log(`[AAMP] pairing code left active so ${request.from} can retry before it expires`)
    }
  }

  private async sendPairResponse(request: PairRequest, success: boolean, reason?: string): Promise<boolean> {
    let lastError: unknown
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.client.sendPairRespond({
          to: request.from,
          taskId: request.taskId,
          success,
          reason,
          inReplyTo: request.messageId,
        })
        return true
      } catch (error) {
        lastError = error
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 1_000))
        }
      }
    }
    this.logger.error(`[AAMP] pair.respond failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    return false
  }

  private async updateLedger(entry: LedgerEntry): Promise<void> {
    this.ledger.tasks[entry.taskId] = entry
    await writeJsonFile(this.ledgerFile, this.ledger)
  }

  private commandByName(name: string): RegisteredCommand | undefined {
    return this.config.commands.find((command) => command.name === name)
  }

  private async ensureStream(dispatch: TaskDispatch, mode: StreamMode): Promise<string | undefined> {
    if (mode === 'none') return undefined
    const stream = await this.client.createStream({
      taskId: dispatch.taskId,
      peerEmail: dispatch.from,
    })
    await this.client.sendStreamOpened({
      to: dispatch.from,
      taskId: dispatch.taskId,
      streamId: stream.streamId,
      inReplyTo: dispatch.messageId,
    })
    return stream.streamId
  }

  private async appendStream(streamId: string | undefined, type: AampStreamEvent['type'], payload: Record<string, unknown>, mode: StreamMode): Promise<void> {
    if (!streamId || mode === 'none') return
    if (mode === 'status-only' && type === 'text.delta') return
    await this.client.appendStreamEvent({ streamId, type, payload }).catch(() => {})
  }

  private async closeStream(streamId: string | undefined, payload: Record<string, unknown>): Promise<void> {
    if (!streamId) return
    await this.client.closeStream({ streamId, payload }).catch(() => {})
  }

  private async sendRejectedResult(
    dispatch: TaskDispatch,
    commandName: string,
    summary: string,
    errorMsg?: string,
    streamId?: string,
    mode: StreamMode = 'status-only',
  ): Promise<void> {
    const now = new Date()
    const result: RegisteredCommandResultPayload = {
      kind: 'registered-command-result/v1',
      command: commandName,
      status: 'rejected',
      exitCode: null,
      summary,
      stderr: errorMsg,
      truncated: {
        stdout: false,
        stderr: false,
      },
      timing: {
        startedAt: now.toISOString(),
        finishedAt: now.toISOString(),
        durationMs: 0,
      },
    }

    await this.appendStream(streamId, 'status', { stage: 'rejected', summary }, mode)
    await this.appendStream(streamId, 'error', { message: errorMsg ?? summary }, mode)
    await this.appendStream(streamId, 'done', { status: 'rejected' }, mode)
    await this.client.sendResult({
      to: dispatch.from,
      taskId: dispatch.taskId,
      status: 'rejected',
      output: summary,
      errorMsg,
      inReplyTo: dispatch.messageId,
      rawBodyText: createResultBody(result),
    })
    await this.closeStream(streamId, { status: 'rejected' })
  }

  private async handleDispatch(dispatch: TaskDispatch): Promise<void> {
    if (!isDispatchForThisNode(dispatch, this.client.email)) {
      this.logger.log(`[AAMP] ignoring dispatch ${dispatch.taskId} because to=${dispatch.to} does not match node mailbox ${this.client.email}`)
      return
    }

    if (isSelfSentDispatch(dispatch, this.client.email)) {
      this.logger.log(`[AAMP] ignoring self-sent dispatch ${dispatch.taskId} from ${dispatch.from}`)
      return
    }

    const existing = this.ledger.tasks[dispatch.taskId]
    if (existing?.status === 'completed' || existing?.status === 'rejected' || existing?.status === 'cancelled' || existing?.status === 'expired') {
      this.logger.log(`[AAMP] skipping duplicate task ${dispatch.taskId} (${existing.status})`)
      return
    }
    if (existing?.status === 'interrupted') {
      await this.sendRejectedResult(
        dispatch,
        existing.command,
        `Task ${dispatch.taskId} was interrupted during a previous local execution and will not be retried automatically.`,
        'Previous local execution ended unexpectedly.',
      )
      await this.updateLedger({
        ...existing,
        status: 'rejected',
        updatedAt: new Date().toISOString(),
      })
      return
    }

    if (isExpiredDispatch(dispatch)) {
      this.logger.log(`[AAMP] ignoring expired dispatch ${dispatch.taskId} (expiresAt=${dispatch.expiresAt})`)
      await this.updateLedger({
        taskId: dispatch.taskId,
        command: 'unknown',
        from: dispatch.from,
        status: 'expired',
        messageId: dispatch.messageId,
        updatedAt: new Date().toISOString(),
      })
      return
    }

    try {
      const history = await this.client.getThreadHistory(dispatch.taskId)
      if (hasTerminalThreadEvent(history.events, dispatch.taskId)) {
        this.logger.log(`[AAMP] ignoring historical dispatch ${dispatch.taskId} because the thread already has a terminal event`)
        return
      }
    } catch (error) {
      this.logger.error(`[AAMP] thread check ${dispatch.taskId} failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    let payload: RegisteredCommandDispatchPayload
    try {
      payload = parseRegisteredCommandPayload(dispatch.bodyText)
    } catch (error) {
      await this.sendRejectedResult(
        dispatch,
        'unknown',
        'Dispatch payload is invalid.',
        error instanceof Error ? error.message : String(error),
      )
      await this.updateLedger({
        taskId: dispatch.taskId,
        command: 'unknown',
        from: dispatch.from,
        status: 'rejected',
        messageId: dispatch.messageId,
        updatedAt: new Date().toISOString(),
      })
      return
    }

    const command = this.commandByName(payload.command)
    if (!command || command.enabled === false) {
      await this.sendRejectedResult(
        dispatch,
        payload.command,
        `Command ${payload.command} is not registered on this node.`,
      )
      await this.updateLedger({
        taskId: dispatch.taskId,
        command: payload.command,
        from: dispatch.from,
        status: 'rejected',
        messageId: dispatch.messageId,
        updatedAt: new Date().toISOString(),
      })
      return
    }

    const policyDecision = decidePolicy(this.config, dispatch, command)
    if (!policyDecision.allowed) {
      await this.sendRejectedResult(
        dispatch,
        command.name,
        'Sender policy rejected this dispatch.',
        policyDecision.reason,
      )
      await this.updateLedger({
        taskId: dispatch.taskId,
        command: command.name,
        from: dispatch.from,
        status: 'rejected',
        messageId: dispatch.messageId,
        updatedAt: new Date().toISOString(),
      })
      return
    }

    const schemaErrors = validateAgainstSchema(payload.args ?? {}, command.argSchema)
    if (schemaErrors.length > 0) {
      await this.sendRejectedResult(
        dispatch,
        command.name,
        'Dispatch arguments did not match the registered schema.',
        schemaErrors.join(' '),
      )
      await this.updateLedger({
        taskId: dispatch.taskId,
        command: command.name,
        from: dispatch.from,
        status: 'rejected',
        messageId: dispatch.messageId,
        updatedAt: new Date().toISOString(),
      })
      return
    }

    const streamMode = streamModeFromPayload(payload)
    const streamId = await this.ensureStream(dispatch, streamMode)
    const startedAt = new Date()
    await this.appendStream(streamId, 'status', { stage: 'running', command: command.name }, streamMode)

    await this.updateLedger({
      taskId: dispatch.taskId,
      command: command.name,
      from: dispatch.from,
      status: 'running',
      messageId: dispatch.messageId,
      updatedAt: startedAt.toISOString(),
    })

    try {
      const normalizedArgs = await normalizeArgsForCommand(command, ensureJsonObject(payload.args))
      const runDir = await ensureRunDirectory(command, dispatch.taskId)
      const inputs = await downloadInputs(this.client, command, payload, dispatch, runDir)
      const argv = renderArgsTemplate(command.argsTemplate, normalizedArgs, inputs)
      await this.executeCommand({
        dispatch,
        command,
        argv,
        runDir,
        streamId,
        streamMode,
        startedAt,
      })
    } catch (error) {
      await this.sendRejectedResult(
        dispatch,
        command.name,
        `Command ${command.name} could not start.`,
        error instanceof Error ? error.message : String(error),
        streamId,
        streamMode,
      )
      await this.updateLedger({
        taskId: dispatch.taskId,
        command: command.name,
        from: dispatch.from,
        status: 'rejected',
        messageId: dispatch.messageId,
        updatedAt: new Date().toISOString(),
      })
    }
  }

  private async executeCommand(params: {
    dispatch: TaskDispatch
    command: RegisteredCommand
    argv: string[]
    runDir: string
    streamId?: string
    streamMode: StreamMode
    startedAt: Date
  }): Promise<void> {
    const stdoutFile = path.join(params.runDir, 'stdout.log')
    const stderrFile = path.join(params.runDir, 'stderr.log')
    const preview = createExecutionBuffers()
    await writeFile(stdoutFile, '')
    await writeFile(stderrFile, '')

    const child = this.spawnProcess(params.command.exec, params.argv, {
      cwd: params.command.workingDirectory,
      env: buildCommandEnvironment(params.command),
      shell: false,
      stdio: 'pipe',
    })
    const activeTask: ActiveTask = {
      taskId: params.dispatch.taskId,
      child,
      streamId: params.streamId,
      cancelled: false,
      dispatch: params.dispatch,
      command: params.command,
    }
    this.activeTasks.set(params.dispatch.taskId, activeTask)

    child.stdout.on('data', (chunk: Buffer) => {
      preview.stdoutBytes += chunk.length
      void writeFile(stdoutFile, chunk, { flag: 'a' })
      const rendered = appendPreview(preview.stdoutPreview, chunk, params.command.maxStdoutBytes ?? 16_384)
      preview.stdoutPreview = rendered.text
      preview.stdoutTruncated ||= rendered.truncated
      void this.appendStream(params.streamId, 'text.delta', { stream: 'stdout', text: chunk.toString('utf8') }, params.streamMode)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      preview.stderrBytes += chunk.length
      void writeFile(stderrFile, chunk, { flag: 'a' })
      const rendered = appendPreview(preview.stderrPreview, chunk, params.command.maxStderrBytes ?? 16_384)
      preview.stderrPreview = rendered.text
      preview.stderrTruncated ||= rendered.truncated
      void this.appendStream(params.streamId, 'text.delta', { stream: 'stderr', text: chunk.toString('utf8') }, params.streamMode)
    })

    const timeoutMs = params.command.timeoutMs ?? 60_000
    const timeout = setTimeout(() => {
      activeTask.cancelled = true
      child.kill('SIGTERM')
      activeTask.cancelTimer = setTimeout(() => child.kill('SIGKILL'), 5_000)
    }, timeoutMs)

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code) => resolve(code))
    }).finally(() => {
      clearTimeout(timeout)
      if (activeTask.cancelTimer) clearTimeout(activeTask.cancelTimer)
      this.activeTasks.delete(params.dispatch.taskId)
    })

    const finishedAt = new Date()
    const status = exitCode === 0 && !activeTask.cancelled ? 'completed' : 'rejected'
    const summary = summarizeExit(params.command.name, exitCode, activeTask.cancelled)

    const attachments: AampAttachment[] = []
    const resultAttachments: RegisteredCommandResultPayload['attachments'] = []
    if (preview.stdoutTruncated) {
      attachments.push(await createOutputAttachment(stdoutFile, `${sanitizeName(params.command.name)}-stdout.txt`))
      resultAttachments.push({ name: `${sanitizeName(params.command.name)}-stdout.txt`, contentType: 'text/plain' })
    }
    if (preview.stderrTruncated) {
      attachments.push(await createOutputAttachment(stderrFile, `${sanitizeName(params.command.name)}-stderr.txt`))
      resultAttachments.push({ name: `${sanitizeName(params.command.name)}-stderr.txt`, contentType: 'text/plain' })
    }
    const structuredResult = !preview.stdoutTruncated
      ? parseStructuredResultFromCommandOutput(preview.stdoutPreview)
      : undefined

    const resultPayload: RegisteredCommandResultPayload = {
      kind: 'registered-command-result/v1',
      command: params.command.name,
      status,
      exitCode,
      summary,
      stdout: preview.stdoutPreview || undefined,
      stderr: preview.stderrPreview || undefined,
      truncated: {
        stdout: preview.stdoutTruncated,
        stderr: preview.stderrTruncated,
      },
      ...(resultAttachments.length ? { attachments: resultAttachments } : {}),
      ...(structuredResult?.length ? { structuredResult } : {}),
      timing: {
        startedAt: params.startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - params.startedAt.getTime(),
      },
    }

    await this.appendStream(params.streamId, 'status', { stage: status, summary }, params.streamMode)
    await this.appendStream(params.streamId, 'done', { status, exitCode }, params.streamMode)
    await this.client.sendResult({
      to: params.dispatch.from,
      taskId: params.dispatch.taskId,
      status,
      output: summary,
      errorMsg: status === 'rejected' ? preview.stderrPreview || undefined : undefined,
      inReplyTo: params.dispatch.messageId,
      rawBodyText: createResultBody(resultPayload),
      structuredResult,
      attachments,
    })
    await this.closeStream(params.streamId, { status, exitCode })
    await this.updateLedger({
      taskId: params.dispatch.taskId,
      command: params.command.name,
      from: params.dispatch.from,
      status: activeTask.cancelled ? 'cancelled' : status,
      messageId: params.dispatch.messageId,
      updatedAt: finishedAt.toISOString(),
    })
  }

  private async handleCancel(cancel: TaskCancel): Promise<void> {
    const active = this.activeTasks.get(cancel.taskId)
    if (!active) {
      this.logger.log(`[AAMP] received cancel for inactive task ${cancel.taskId}`)
      return
    }

    active.cancelled = true
    await this.appendStream(active.streamId, 'status', { stage: 'cancelling', reason: cancel.bodyText || 'Task cancelled by dispatcher.' }, 'status-only')
    active.child.kill('SIGTERM')
    active.cancelTimer = setTimeout(() => active.child.kill('SIGKILL'), 5_000)
  }
}

export async function runNodeServe(
  nodeName: string,
  config: NodeConfig,
  logger: LoggerLike = console,
  options: NodeServeOptions = {},
): Promise<void> {
  const client = AampClient.fromMailboxIdentity({
    ...config.mailbox,
  }) as unknown as AampNodeClient
  const service = new AampLocalNodeService(nodeName, config, client, logger)
  await service.start({ quiet: options.quiet })
  if (options.quiet) {
    logger.log(`AAMP node running:\n   ${nodeName}: ${client.email}`)
  }

  const shutdown = () => {
    service.stop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await new Promise<void>(() => {})
}

export function buildNodeCapabilityCard(config: NodeConfig): string {
  const lines = [
    '# Local Registered Commands',
    '',
    `Mailbox: ${config.mailbox.email}`,
    '',
  ]

  if (config.commands.length === 0) {
    lines.push('No commands are currently registered.')
    return lines.join('\n')
  }

  for (const command of config.commands) {
    lines.push(`## ${command.name}`)
    if (command.description) lines.push(command.description)
    lines.push(`- Working directory: ${command.workingDirectory}`)
    lines.push(`- Exec: ${command.exec}`)
    if (command.argSchema) {
      lines.push('- Args schema:')
      lines.push('```json')
      lines.push(JSON.stringify(command.argSchema, null, 2))
      lines.push('```')
    }
    if (command.environment && Object.keys(command.environment).length > 0) {
      lines.push(`- Environment variables: ${Object.keys(command.environment).join(', ')}`)
    }
    if (command.attachments && Object.keys(command.attachments).length > 0) {
      lines.push('- Attachment slots:')
      lines.push('```json')
      lines.push(JSON.stringify(command.attachments, null, 2))
      lines.push('```')
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function createNodeResultAttachmentName(commandName: string, stream: 'stdout' | 'stderr'): string {
  return `${sanitizeName(commandName)}-${stream}.txt`
}

export function createNodeConfigSummary(config: NodeConfig): string {
  return `${config.commands.length} registered command(s); mailbox ${config.mailbox.email}`
}

export function makeNodeClient(config: NodeConfig): AampNodeClient {
  return AampClient.fromMailboxIdentity({
    ...config.mailbox,
  }) as unknown as AampNodeClient
}

export function createEmptyLedger(): LedgerState {
  return {
    version: 1,
    tasks: {},
  }
}

export { decidePolicy, validateAgainstSchema, renderArgsTemplate }
