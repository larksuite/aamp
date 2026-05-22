import type { StructuredResultField, TaskDispatch } from 'aamp-sdk'

const STRUCTURED_RESULT_MARKER = 'AAMP_RESULT_JSON:'

export interface ResultAttachmentRef {
  path: string
  filename?: string
  contentType?: string
}

type StructuredPayload = {
  output?: string
  structuredResult?: StructuredResultField[]
  attachments?: ResultAttachmentRef[]
}

function isCliTranscriptHeader(line: string): boolean {
  return /^\[(acpx|client|tool|done|error|warning)\](?:\s|$)/i.test(line)
}

function buildStructuredResultInstructions(): string {
  return [
    `Structured result handoff:`,
    `- If the task asks for structuredResult, field backfill, Meego field output, attachments, or aamp_send_result, include a final ${STRUCTURED_RESULT_MARKER} block.`,
    `- The block must be valid JSON and may include output, structuredResult, and attachments.`,
    `- Attachment entries should include filename, contentType, and path.`,
    `- Use this shape:`,
    `${STRUCTURED_RESULT_MARKER}`,
    '```json',
    '{"output":"Human-readable summary.","attachments":[{"filename":"file.zip","contentType":"application/zip","path":"/absolute/path/to/file.zip"}],"structuredResult":[{"fieldKey":"<fieldKey>","fieldTypeKey":"<fieldTypeKey>","value":"<field value>"}]}',
    '```',
    `- For attachment fields, also reference attached files with attachmentFilenames.`,
    `- The bridge strips this block from the visible reply, sends structuredResult as X-AAMP-StructuredResult, and sends attachments as email attachments.`,
  ].join('\n')
}

function sanitizeAgentResponse(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (!trimmed.split(/\r?\n/).some((line) => isCliTranscriptHeader(line))) {
    return trimmed
  }

  const lines = trimmed.replace(/\r\n/g, '\n').split('\n')
  const textBlocks: string[] = []
  let currentBlock: string[] = []
  let skippingTranscriptDetails = false

  const flushBlock = () => {
    const block = currentBlock.join('\n').trim()
    if (block) textBlocks.push(block)
    currentBlock = []
  }

  for (const line of lines) {
    if (isCliTranscriptHeader(line)) {
      flushBlock()
      skippingTranscriptDetails = true
      continue
    }

    if (skippingTranscriptDetails) {
      if (!line || /^[ \t]+/.test(line)) {
        continue
      }
      skippingTranscriptDetails = false
    }

    currentBlock.push(line)
  }

  flushBlock()
  return textBlocks.at(-1) ?? ''
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

function normalizeAttachmentRef(value: unknown): ResultAttachmentRef | null {
  if (typeof value === 'string' && value.trim()) {
    return { path: value.trim() }
  }

  const record = asRecord(value)
  if (!record) return null

  const path = asString(record.path ?? record.filePath ?? record.file)
  if (!path) return null

  const filename = asString(record.filename ?? record.name)
  const contentType = asString(record.contentType ?? record.mimeType ?? record.type)

  return {
    path,
    ...(filename ? { filename } : {}),
    ...(contentType ? { contentType } : {}),
  }
}

function normalizeAttachments(value: unknown): ResultAttachmentRef[] | undefined {
  if (typeof value === 'string') {
    const attachment = normalizeAttachmentRef(value)
    return attachment ? [attachment] : undefined
  }
  if (!Array.isArray(value)) return undefined

  const attachments = value
    .map((item) => normalizeAttachmentRef(item))
    .filter((item): item is ResultAttachmentRef => item != null)

  return attachments.length ? attachments : undefined
}

function parseStructuredPayload(value: unknown): StructuredPayload | null {
  const record = asRecord(value)
  const structuredResult = Array.isArray(value)
    ? normalizeStructuredResult(value)
    : normalizeStructuredResult(record?.structuredResult ?? record?.structured_result)
  const attachments = normalizeAttachments(record?.attachments ?? record?.attachment)

  if (!structuredResult?.length && !attachments?.length) return null

  const output = asString(record?.output)

  return {
    ...(output ? { output } : {}),
    ...(structuredResult ? { structuredResult } : {}),
    ...(attachments ? { attachments } : {}),
  }
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
    if ((char === '}' && opener !== '{') || (char === ']' && opener !== '[')) {
      return null
    }

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
    const jsonText = fenceMatch[1].trim()
    return {
      jsonText,
      start: trimmedStart,
      end: trimmedStart + fenceMatch[0].length,
    }
  }

  return extractBalancedJsonRange(source)
}

function parsePayloadJson(jsonText: string): StructuredPayload | null {
  try {
    return parseStructuredPayload(JSON.parse(jsonText))
  } catch {
    return null
  }
}

function extractMarkedStructuredPayload(text: string): {
  output: string
  structuredResult?: StructuredResultField[]
  attachments?: ResultAttachmentRef[]
} | null {
  const markerIndex = text.lastIndexOf(STRUCTURED_RESULT_MARKER)
  if (markerIndex < 0) return null

  const before = text.slice(0, markerIndex).trim()
  const after = text.slice(markerIndex + STRUCTURED_RESULT_MARKER.length)
  const jsonRange = extractJsonFromMaybeFence(after)
  if (!jsonRange) return null

  const payload = parsePayloadJson(jsonRange.jsonText)
  if (!payload) return null

  const trailing = after.slice(jsonRange.end).trim()
  const visibleOutput = payload.output ?? [before, trailing].filter(Boolean).join('\n\n').trim()

  return {
    output: visibleOutput,
    ...(payload.structuredResult ? { structuredResult: payload.structuredResult } : {}),
    ...(payload.attachments ? { attachments: payload.attachments } : {}),
  }
}

function extractWholeJsonStructuredPayload(text: string): {
  output: string
  structuredResult?: StructuredResultField[]
  attachments?: ResultAttachmentRef[]
} | null {
  const trimmed = text.trim()
  const range = extractJsonFromMaybeFence(trimmed)
  if (!range || range.start !== 0 || range.end !== trimmed.length) return null

  const payload = parsePayloadJson(range.jsonText)
  if (!payload) return null

  return {
    output: payload.output ?? '',
    ...(payload.structuredResult ? { structuredResult: payload.structuredResult } : {}),
    ...(payload.attachments ? { attachments: payload.attachments } : {}),
  }
}

function extractLooseStructuredResult(text: string): {
  output: string
  structuredResult: StructuredResultField[]
} | null {
  const match = /(?:^|\n)\s*structuredResult\s*:\s*/i.exec(text)
  if (!match) return null

  const valueStart = match.index + match[0].length
  const after = text.slice(valueStart)
  const range = extractBalancedJsonRange(after)
  if (!range) return null

  const structuredResult = normalizeStructuredResult(JSON.parse(range.jsonText))
  if (!structuredResult?.length) return null

  const before = text.slice(0, match.index).trim()
  const trailing = after.slice(range.end).trim()

  return {
    output: [before, trailing].filter(Boolean).join('\n\n').trim(),
    structuredResult,
  }
}

function extractResultPayload(text: string): {
  output: string
  structuredResult?: StructuredResultField[]
  attachments?: ResultAttachmentRef[]
} {
  const marked = extractMarkedStructuredPayload(text)
  if (marked) return marked

  const wholeJson = extractWholeJsonStructuredPayload(text)
  if (wholeJson) return wholeJson

  try {
    const loose = extractLooseStructuredResult(text)
    if (loose) return loose
  } catch {
    // Fall through to plain text if a loose structuredResult block is malformed.
  }

  return { output: text.trim() }
}

function isConversationalTask(task: TaskDispatch): boolean {
  const source = task.dispatchContext?.source?.trim().toLowerCase()
  return source === 'feishu' || source === 'wechat' || source === 'ios'
}

function displayAgentName(task: TaskDispatch, agentName?: string): string {
  const trimmed = agentName?.trim()
  if (trimmed) return trimmed
  return task.to.split('@')[0] || 'the connected agent'
}

/**
 * Convert an AAMP TaskDispatch into a prompt string for an ACP agent.
 */
export function buildPrompt(task: TaskDispatch, threadContextText?: string, agentName?: string): string {
  const agentDisplayName = displayAgentName(task, agentName)
  const dispatchContextLines = task.dispatchContext && Object.keys(task.dispatchContext).length > 0
    ? `Dispatch Context:\n${Object.entries(task.dispatchContext).map(([key, value]) => `  - ${key}: ${value}`).join('\n')}`
    : ''

  const parts = isConversationalTask(task)
    ? [
        `## AAMP Conversation Turn`,
        ``,
        `This task came from a chat surface (${task.dispatchContext?.source ?? 'unknown'}).`,
        `You are ${agentDisplayName}. AAMP and AAMP App are only the transport/client channel, not your identity.`,
        `Treat it as an ongoing conversation turn, not a ticket or work order.`,
        `Reply naturally to the user's latest message and keep the conversation moving.`,
        ``,
        `Identity rules:`,
        `- Do not introduce yourself as AAMP, AAMP App, or an AAMP assistant.`,
        `- If you mention who you are, identify as ${agentDisplayName}.`,
        ``,
        `Behavior rules:`,
        `- A normal conversational reply is the default.`,
        `- Greetings, acknowledgements, short follow-up questions, and direct answers are all valid replies.`,
        `- Do not ask for clarification just because the user message is short or casual.`,
        `- Only start your response with "HELP:" when you are truly blocked and cannot produce any meaningful reply without specific missing information.`,
        ``,
        `Task ID: ${task.taskId}`,
        `From: ${task.from}`,
        `Agent: ${agentDisplayName}`,
        `Title: ${task.title}`,
        `Priority: ${task.priority}`,
        dispatchContextLines,
        task.bodyText ? `Latest user message:\n${task.bodyText}` : '',
        threadContextText?.trim() ? threadContextText : '',
        task.expiresAt ? `Expires At: ${task.expiresAt}` : '',
        ``,
        `Execution rules:`,
        `- Treat the Latest user message section and any prior thread context below as the only conversation context you were given.`,
        `- If that context does not contain the actual user request or is otherwise insufficient, respond with HELP instead of trying to reconstruct intent from local files, account state, or remote services.`,
        `- Do not search outside the current working directory unless the user message explicitly asks you to inspect a specific external path.`,
        `- Do not inspect the filesystem, credentials, mailbox state, home directory, or network just to guess what the user probably meant.`,
        `- For simple chat messages that are fully present in the prompt, answer them directly without workspace exploration.`,
        ``,
        `Keep your final reply limited to the final user-facing message.`,
        `Do not include planning notes, thought process, tool logs, or intermediate progress updates in the final reply.`,
        ``,
        buildStructuredResultInstructions(),
        ``,
        `If you create any files as part of this task, list each file path at the end of your response in this exact format:`,
        `FILE:/absolute/path/to/file`,
      ]
    : [
        `## AAMP Task`,
        ``,
        `You are ${agentDisplayName}. AAMP and AAMP App are only the transport/client channel, not your identity.`,
        `Do not introduce yourself as AAMP, AAMP App, or an AAMP assistant. If you mention who you are, identify as ${agentDisplayName}.`,
        ``,
        `Task ID: ${task.taskId}`,
        `From: ${task.from}`,
        `Agent: ${agentDisplayName}`,
        `Title: ${task.title}`,
        `Priority: ${task.priority}`,
        dispatchContextLines,
        task.bodyText ? `Description:\n${task.bodyText}` : '',
        threadContextText?.trim() ? threadContextText : '',
        task.expiresAt ? `Expires At: ${task.expiresAt}` : '',
        ``,
        `Execution rules:`,
        `- Treat the Description section and any prior thread context below as the only task context you were given.`,
        `- If that context does not contain the actual user request or is otherwise insufficient, respond with HELP instead of trying to reconstruct the task from local files, account state, or remote services.`,
        `- Do not search outside the current working directory unless the task explicitly asks you to inspect a specific external path.`,
        `- Do not inspect the filesystem, credentials, mailbox state, home directory, or network just to figure out what the task probably meant.`,
        `- For simple chat messages that are fully present in the prompt, answer them directly without workspace exploration.`,
        ``,
        `Please complete this task and output your result directly.`,
        `Keep your final reply limited to the final user-facing result.`,
        `Do not include planning notes, thought process, tool logs, or intermediate progress updates in the final reply.`,
        `If you cannot complete the task and need more information, start your response with "HELP:" followed by your question.`,
        ``,
        buildStructuredResultInstructions(),
        ``,
        `If you create any files as part of this task, list each file path at the end of your response in this exact format:`,
        `FILE:/absolute/path/to/file`,
      ]
  return parts.filter(Boolean).join('\n')
}

/**
 * Parse an ACP agent response to detect HELP requests and extract file paths.
 * Returns { isHelp, question, output, files }.
 */
export function parseResponse(output: string): {
  isHelp: boolean
  question?: string
  output: string
  files: string[]
  structuredResult?: StructuredResultField[]
  attachments?: ResultAttachmentRef[]
} {
  const trimmed = sanitizeAgentResponse(output)
  if (trimmed.startsWith('HELP:')) {
    return {
      isHelp: true,
      question: trimmed.slice(5).trim(),
      output: '',
      files: [],
    }
  }

  // Extract FILE: lines
  const files: string[] = []
  const lines = trimmed.split('\n')
  const outputLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('FILE:')) {
      const path = line.slice(5).trim()
      if (path) files.push(path)
    } else {
      outputLines.push(line)
    }
  }

  const structured = extractResultPayload(outputLines.join('\n').trim())

  return {
    isHelp: false,
    output: structured.output,
    files,
    ...(structured.structuredResult ? { structuredResult: structured.structuredResult } : {}),
    ...(structured.attachments ? { attachments: structured.attachments } : {}),
  }
}
