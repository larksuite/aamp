/**
 * AAMP Header Parser
 *
 * Parses AAMP protocol headers from email messages.
 * Works with both raw header objects and JMAP Email objects.
 *
 * Headers are case-insensitive; we normalize to lowercase for lookup.
 */

import { AAMP_HEADER, type AampMessage, type TaskDispatch, type TaskResult, type TaskHelp, type TaskAck } from './types.js'

type RawHeaders = Record<string, string | string[]>

function decodeMimeEncodedWordSegment(segment: string): string {
  const match = /^=\?([^?]+)\?([bBqQ])\?([^?]*)\?=$/.exec(segment)
  if (!match) return segment

  const [, charsetRaw, encodingRaw, body] = match
  const charset = charsetRaw.toLowerCase()
  const encoding = encodingRaw.toUpperCase()

  try {
    if (encoding === 'B') {
      const buf = Buffer.from(body, 'base64')
      return buf.toString(charset === 'utf-8' || charset === 'utf8' ? 'utf8' : 'utf8')
    }

    const normalized = body
      .replace(/_/g, ' ')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      )
    const bytes = Buffer.from(normalized, 'binary')
    return bytes.toString(charset === 'utf-8' || charset === 'utf8' ? 'utf8' : 'utf8')
  } catch {
    return segment
  }
}

function decodeMimeEncodedWords(value?: string): string {
  if (!value || !value.includes('=?')) return value ?? ''
  const collapsed = value.replace(/\r?\n[ \t]+/g, ' ')
  const decoded = collapsed.replace(/=\?[^?]+\?[bBqQ]\?[^?]*\?=/g, (segment) =>
    decodeMimeEncodedWordSegment(segment),
  )
  return decoded.replace(/\s{2,}/g, ' ').trim()
}

/**
 * Normalize a header map to lowercase keys with string values
 */
export function normalizeHeaders(headers: RawHeaders): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [
      k.toLowerCase(),
      Array.isArray(v) ? v[0] : v,
    ]),
  )
}

/**
 * Get a header value by its X-AAMP-* name (case-insensitive)
 */
function getAampHeader(
  headers: Record<string, string>,
  headerName: string,
): string | undefined {
  return headers[headerName.toLowerCase()]
}

const DISPATCH_CONTEXT_KEY_RE = /^[a-z0-9_-]+$/

export function parseDispatchContextHeader(value?: string): Record<string, string> | undefined {
  if (!value) return undefined
  const context: Record<string, string> = {}

  for (const part of value.split(';')) {
    const segment = part.trim()
    if (!segment) continue
    const eqIdx = segment.indexOf('=')
    if (eqIdx <= 0) continue
    const rawKey = segment.slice(0, eqIdx).trim()
    const rawValue = segment.slice(eqIdx + 1).trim()
    if (!DISPATCH_CONTEXT_KEY_RE.test(rawKey)) continue
    try {
      context[rawKey] = decodeURIComponent(rawValue)
    } catch {
      context[rawKey] = rawValue
    }
  }

  return Object.keys(context).length ? context : undefined
}

export function serializeDispatchContextHeader(context?: Record<string, string>): string | undefined {
  if (!context) return undefined
  const parts = Object.entries(context)
    .flatMap(([key, value]) => {
      const normalizedKey = key.trim().toLowerCase()
      if (!DISPATCH_CONTEXT_KEY_RE.test(normalizedKey)) return []
      const normalizedValue = String(value ?? '').trim()
      if (!normalizedValue) return []
      return `${normalizedKey}=${encodeURIComponent(normalizedValue)}`
    })
  return parts.length ? parts.join('; ') : undefined
}

function decodeStructuredResult(value?: string): TaskResult['structuredResult'] | undefined {
  if (!value) return undefined
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
    const padding = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4))
    const decoded = Buffer.from(normalized + padding, 'base64').toString('utf-8')
    return JSON.parse(decoded) as TaskResult['structuredResult']
  } catch {
    return undefined
  }
}

function encodeStructuredResult(value?: TaskResult['structuredResult']): string | undefined {
  if (!value) return undefined
  const json = JSON.stringify(value)
  return Buffer.from(json, 'utf-8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export interface EmailMetadata {
  from: string
  to: string
  messageId: string
  subject: string
  headers: RawHeaders
}

/**
 * Parse AAMP headers from an email's header map.
 * Returns null if this email is not an AAMP message.
 *
 * @param meta - Email metadata (from, to, messageId, subject, headers)
 */
export function parseAampHeaders(meta: EmailMetadata): AampMessage | null {
  const headers = normalizeHeaders(meta.headers)

  const intent = getAampHeader(headers, AAMP_HEADER.INTENT)
  const taskId = getAampHeader(headers, AAMP_HEADER.TASK_ID)

  if (!intent || !taskId) return null

  const from = meta.from.replace(/^<|>$/g, '')
  const to = meta.to.replace(/^<|>$/g, '')
  const decodedSubject = decodeMimeEncodedWords(meta.subject)

  if (intent === 'task.dispatch') {
    const timeoutStr = getAampHeader(headers, AAMP_HEADER.TIMEOUT) ?? '300'
    const contextLinksStr = getAampHeader(headers, AAMP_HEADER.CONTEXT_LINKS) ?? ''
    const dispatchContext = parseDispatchContextHeader(
      getAampHeader(headers, AAMP_HEADER.DISPATCH_CONTEXT),
    )

    const parentTaskId = getAampHeader(headers, AAMP_HEADER.PARENT_TASK_ID)

    const dispatch: TaskDispatch = {
      intent: 'task.dispatch',
      taskId,
      title: decodedSubject.replace(/^\[AAMP Task\]\s*/, '').trim() || 'Untitled Task',
      timeoutSecs: parseInt(timeoutStr, 10) || 300,
      contextLinks: contextLinksStr
        ? contextLinksStr.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      ...(dispatchContext ? { dispatchContext } : {}),
      ...(parentTaskId ? { parentTaskId } : {}),
      from,
      to,
      messageId: meta.messageId,
      subject: meta.subject,
      bodyText: '', // filled in by jmap-push.ts after parsing
    }
    return dispatch
  }

  if (intent === 'task.result') {
    const status = (getAampHeader(headers, AAMP_HEADER.STATUS) ?? 'completed') as
      | 'completed'
      | 'rejected'
    const output = getAampHeader(headers, AAMP_HEADER.OUTPUT) ?? ''
    const errorMsg = getAampHeader(headers, AAMP_HEADER.ERROR_MSG)
    const structuredResult = decodeStructuredResult(
      getAampHeader(headers, AAMP_HEADER.STRUCTURED_RESULT),
    )

    const result: TaskResult = {
      intent: 'task.result',
      taskId,
      status,
      output: decodeMimeEncodedWords(output),
      errorMsg: errorMsg ? decodeMimeEncodedWords(errorMsg) : errorMsg,
      structuredResult,
      from,
      to,
      messageId: meta.messageId,
    }
    return result
  }

  if (intent === 'task.help') {
    const question = getAampHeader(headers, AAMP_HEADER.QUESTION) ?? ''
    const blockedReason = getAampHeader(headers, AAMP_HEADER.BLOCKED_REASON) ?? ''
    const suggestedOptionsStr = getAampHeader(headers, AAMP_HEADER.SUGGESTED_OPTIONS) ?? ''

    const help: TaskHelp = {
      intent: 'task.help',
      taskId,
      question: decodeMimeEncodedWords(question),
      blockedReason: decodeMimeEncodedWords(blockedReason),
      suggestedOptions: suggestedOptionsStr
        ? suggestedOptionsStr.split('|').map((s) => decodeMimeEncodedWords(s.trim())).filter(Boolean)
        : [],
      from,
      to,
      messageId: meta.messageId,
    }
    return help
  }

  if (intent === 'task.ack') {
    const ack: TaskAck = {
      intent: 'task.ack',
      taskId,
      from,
      to,
      messageId: meta.messageId,
    }
    return ack
  }

  return null
}

/**
 * Build AAMP headers for a task.dispatch email
 */
export function buildDispatchHeaders(params: {
  taskId: string
  /** Omit or pass undefined/null to send without a deadline */
  timeoutSecs?: number | null
  contextLinks: string[]
  dispatchContext?: Record<string, string>
  parentTaskId?: string
}): Record<string, string> {
  const headers: Record<string, string> = {
    [AAMP_HEADER.INTENT]: 'task.dispatch',
    [AAMP_HEADER.TASK_ID]: params.taskId,
  }
  if (params.timeoutSecs != null) {
    headers[AAMP_HEADER.TIMEOUT] = String(params.timeoutSecs)
  }
  if (params.contextLinks.length > 0) {
    headers[AAMP_HEADER.CONTEXT_LINKS] = params.contextLinks.join(',')
  }
  const dispatchContext = serializeDispatchContextHeader(params.dispatchContext)
  if (dispatchContext) {
    headers[AAMP_HEADER.DISPATCH_CONTEXT] = dispatchContext
  }
  if (params.parentTaskId) {
    headers[AAMP_HEADER.PARENT_TASK_ID] = params.parentTaskId
  }
  return headers
}

/**
 * Build AAMP headers for a task.ack email
 */
export function buildAckHeaders(opts: { taskId: string }): Record<string, string> {
  return {
    [AAMP_HEADER.INTENT]: 'task.ack',
    [AAMP_HEADER.TASK_ID]: opts.taskId,
  }
}

/**
 * Build AAMP headers for a task.result email
 */
export function buildResultHeaders(params: {
  taskId: string
  status: 'completed' | 'rejected'
  output: string
  errorMsg?: string
  structuredResult?: TaskResult['structuredResult']
}): Record<string, string> {
  const headers: Record<string, string> = {
    [AAMP_HEADER.INTENT]: 'task.result',
    [AAMP_HEADER.TASK_ID]: params.taskId,
    [AAMP_HEADER.STATUS]: params.status,
    [AAMP_HEADER.OUTPUT]: params.output,
  }
  if (params.errorMsg) {
    headers[AAMP_HEADER.ERROR_MSG] = params.errorMsg
  }
  const structuredResult = encodeStructuredResult(params.structuredResult)
  if (structuredResult) {
    headers[AAMP_HEADER.STRUCTURED_RESULT] = structuredResult
  }
  return headers
}

/**
 * Build AAMP headers for a task.help email
 */
export function buildHelpHeaders(params: {
  taskId: string
  question: string
  blockedReason: string
  suggestedOptions: string[]
}): Record<string, string> {
  return {
    [AAMP_HEADER.INTENT]: 'task.help',
    [AAMP_HEADER.TASK_ID]: params.taskId,
    [AAMP_HEADER.QUESTION]: params.question,
    [AAMP_HEADER.BLOCKED_REASON]: params.blockedReason,
    [AAMP_HEADER.SUGGESTED_OPTIONS]: params.suggestedOptions.join('|'),
  }
}
