import { spawn } from 'node:child_process'

export interface AcpEvent {
  eventVersion?: number
  sessionId?: string
  requestId?: string
  seq?: number
  type?: string
  messageId?: string
  content?: unknown
  [key: string]: unknown
}

export type AcpTextChunkChannel = 'assistant' | 'thought'

export interface AcpTextChunk {
  channel: AcpTextChunkChannel
  text: string
  messageId?: string
}

export interface AcpToolUpdate {
  toolCallId?: string
  title?: string
  status?: string
  kind?: string
  text?: string
  locations?: Array<{ path: string; line?: number }>
}

export interface AcpPlanEntry {
  content: string
  status?: string
  priority?: string
}

export interface AcpPromptHandlers {
  onEvent?: (event: AcpEvent) => void
  onTextChunk?: (chunk: AcpTextChunk) => void
  onToolUpdate?: (update: AcpToolUpdate) => void
  onPlanUpdate?: (entries: AcpPlanEntry[]) => void
}

export interface AcpResult {
  output: string
  events: AcpEvent[]
  stopReason?: string
  streamedAssistantText: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((item) => extractContentText(item)).join('')
  }

  const record = asRecord(content)
  if (!record) return ''

  if (typeof record.text === 'string') return record.text
  if (typeof record.thinking === 'string') return record.thinking

  const resource = asRecord(record.resource)
  if (resource && typeof resource.text === 'string') return resource.text

  return ''
}

function extractToolLocations(value: unknown): Array<{ path: string; line?: number }> | undefined {
  if (!Array.isArray(value)) return undefined

  const locations = value.flatMap((item) => {
    const record = asRecord(item)
    if (!record) return []
    const path = asString(record.path)
    if (!path) return []

    const line = typeof record.line === 'number' && Number.isFinite(record.line)
      ? record.line
      : undefined

    return [{ path, ...(line != null ? { line } : {}) }]
  })

  return locations.length > 0 ? locations : undefined
}

function extractPlanEntries(value: unknown): AcpPlanEntry[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((item) => {
    const record = asRecord(item)
    const content = asString(record?.content)
    if (!content) return []

    return [{
      content,
      ...(asString(record?.status) ? { status: asString(record?.status) } : {}),
      ...(asString(record?.priority) ? { priority: asString(record?.priority) } : {}),
    }]
  })
}

function normalizeLegacyEvent(record: Record<string, unknown>): AcpEvent | null {
  const rawType = asString(record.type)
  if (!rawType) return null

  const mappedType = rawType === 'thinking' ? 'agent_thought_chunk' : rawType
  return {
    ...record,
    type: mappedType,
    ...(asString(record.sessionId) ? { sessionId: asString(record.sessionId) } : {}),
    ...(asString(record.requestId) ? { requestId: asString(record.requestId) } : {}),
    ...(typeof record.seq === 'number' ? { seq: record.seq } : {}),
  }
}

function normalizeJsonRpcEvent(record: Record<string, unknown>): AcpEvent | null {
  if (record.method === 'session/update') {
    const params = asRecord(record.params)
    if (!params) return null

    const explicitUpdate = asRecord(params.update)
    const fallbackUpdate = asString(params.sessionUpdate)
      ? {
        ...params,
        sessionUpdate: params.sessionUpdate,
      }
      : null
    const update = explicitUpdate ?? fallbackUpdate
    if (!update) return null

    const type = asString(update.sessionUpdate)
    if (!type) return null

    const normalized: AcpEvent = {
      type,
      ...(asString(params.sessionId) ? { sessionId: asString(params.sessionId) } : {}),
    }

    for (const [key, value] of Object.entries(update)) {
      if (key === 'sessionUpdate') continue
      normalized[key] = value
    }

    return normalized
  }

  if (record.result) {
    const result = asRecord(record.result)
    if (!result) return null
    return {
      type: 'result',
      ...(asString(record.id) ? { requestId: asString(record.id) } : {}),
      ...result,
    }
  }

  if (record.error) {
    return {
      type: 'error',
      ...(asString(record.id) ? { requestId: asString(record.id) } : {}),
      error: record.error,
    }
  }

  return null
}

function parseAcpLine(line: string): { event: AcpEvent | null; isJson: boolean } {
  const trimmed = line.trim()
  if (!trimmed) return { event: null, isJson: false }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { event: null, isJson: false }
  }

  const record = asRecord(parsed)
  if (!record) return { event: null, isJson: true }

  if (record.jsonrpc === '2.0') {
    return { event: normalizeJsonRpcEvent(record), isJson: true }
  }

  return { event: normalizeLegacyEvent(record), isJson: true }
}

function supportsJsonStreamingFallback(stderr: string): boolean {
  return /unknown option|unknown argument|unexpected argument|invalid value|--format|--json-strict/i.test(stderr)
}

function isCliTranscriptHeader(line: string): boolean {
  return /^\[(client|tool|done|error|warning)\](?:\s|$)/i.test(line)
}

function extractFinalReplyFromTranscript(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return ''

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

function sanitizePromptOutput(output: string): string {
  const trimmed = output.trim()
  if (!trimmed) return ''
  if (!trimmed.split(/\r?\n/).some((line) => isCliTranscriptHeader(line))) {
    return trimmed
  }
  return extractFinalReplyFromTranscript(trimmed)
}

/**
 * Wrapper around acpx CLI.
 * Invokes acpx as a subprocess and parses NDJSON output.
 */
export class AcpxClient {
  private cwd: string

  constructor(cwd?: string) {
    this.cwd = cwd ?? process.cwd()
  }

  private buildAcpxArgs(agent: string, args: string[], globalArgs: string[] = []): string[] {
    return ['--approve-all', '--cwd', this.cwd, ...globalArgs, agent, ...args]
  }

  private formatArgForLog(arg: string): string {
    const normalized = arg.replace(/\s+/g, ' ').trim()
    if (normalized.length <= 160) return normalized
    return `${normalized.slice(0, 157)}...`
  }

  private formatFailedCommand(agent: string, args: string[], globalArgs: string[] = []): string {
    return ['acpx', ...this.buildAcpxArgs(agent, args, globalArgs)]
      .map((arg) => this.formatArgForLog(arg))
      .join(' ')
  }

  private formatProcessFailure(
    agent: string,
    args: string[],
    code: number | null,
    stdout: string,
    stderr: string,
    globalArgs: string[] = [],
  ): string {
    const details = [
      stderr.trim() ? `stderr: ${stderr.trim()}` : '',
      stdout.trim() ? `stdout: ${stdout.trim()}` : '',
    ].filter(Boolean)

    return `${this.formatFailedCommand(agent, args, globalArgs)} failed (${code ?? 'unknown'}): ${
      details.join('\n') || 'no output from acpx'
    }`
  }

  /**
   * Ensure a named ACP session exists for the given agent.
   */
  async ensureSession(agent: string, sessionName: string): Promise<string> {
    const result = await this.exec(agent, ['sessions', 'ensure', '--name', sessionName])
    // Try to extract sessionId from the JSON output
    try {
      const data = JSON.parse(result.trim().split('\n').pop() ?? '{}')
      return data.sessionId ?? sessionName
    } catch {
      return sessionName
    }
  }

  /**
   * Send a prompt to an ACP agent and wait for completion.
   * Collects all stdout + stderr output and extracts the agent's response.
   */
  async prompt(
    agent: string,
    sessionName: string,
    text: string,
    handlers?: AcpPromptHandlers,
  ): Promise<AcpResult> {
    try {
      return await this.promptJsonMode(agent, sessionName, text, handlers)
    } catch (err) {
      if (supportsJsonStreamingFallback((err as Error).message)) {
        return await this.promptTextMode(agent, sessionName, text)
      }
      throw err
    }
  }

  private async promptJsonMode(
    agent: string,
    sessionName: string,
    text: string,
    handlers?: AcpPromptHandlers,
  ): Promise<AcpResult> {
    const events: AcpEvent[] = []
    let stopReason: string | undefined
    let streamedAssistantText = false
    const assistantMessages = new Map<string, string>()
    const assistantMessageOrder: string[] = []
    let lastAssistantMessageKey: string | undefined
    let previousEventType: string | undefined

    return new Promise<AcpResult>((resolve, reject) => {
      const proc = spawn('acpx', this.buildAcpxArgs(agent, [
        'prompt',
        '-s', sessionName,
        text,
      ], ['--format', 'json', '--json-strict']), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.cwd,
        env: { ...process.env },
      })

      let stdoutBuffer = ''
      let rawStdout = ''
      let stderr = ''

      const processLine = (line: string) => {
        const parsed = parseAcpLine(line)
        const event = parsed.event
        if (!event) {
          if (!parsed.isJson) {
            rawStdout += `${line}\n`
          }
          return
        }

        events.push(event)
        handlers?.onEvent?.(event)

        if (event.type === 'agent_message_chunk') {
          const textChunk = extractContentText(event.content)
          if (textChunk) {
            const messageId = asString(event.messageId)
            const messageKey = messageId
              ?? (previousEventType === 'agent_message_chunk' && lastAssistantMessageKey
                ? lastAssistantMessageKey
                : `anonymous:${assistantMessageOrder.length}`)

            if (!assistantMessages.has(messageKey)) {
              assistantMessages.set(messageKey, '')
              assistantMessageOrder.push(messageKey)
            }

            assistantMessages.set(messageKey, `${assistantMessages.get(messageKey) ?? ''}${textChunk}`)
            lastAssistantMessageKey = messageKey
            streamedAssistantText = true
            handlers?.onTextChunk?.({
              channel: 'assistant',
              text: textChunk,
              ...(messageId ? { messageId } : {}),
            })
          }
          previousEventType = event.type
          return
        }

        if (event.type === 'agent_thought_chunk') {
          const textChunk = extractContentText(event.content)
          if (textChunk) {
            handlers?.onTextChunk?.({
              channel: 'thought',
              text: textChunk,
              messageId: asString(event.messageId),
            })
          }
          previousEventType = event.type
          return
        }

        if (event.type === 'tool_call' || event.type === 'tool_call_update') {
          handlers?.onToolUpdate?.({
            toolCallId: asString(event.toolCallId),
            title: asString(event.title),
            status: asString(event.status),
            kind: asString(event.kind),
            text: extractContentText(event.content),
            locations: extractToolLocations(event.locations),
          })
          previousEventType = event.type
          return
        }

        if (event.type === 'plan') {
          const entries = extractPlanEntries(event.entries)
          if (entries.length > 0) {
            handlers?.onPlanUpdate?.(entries)
          }
          previousEventType = event.type
          return
        }

        if (event.type === 'result') {
          stopReason = asString(event.stopReason)
        }

        previousEventType = event.type
      }

      const processStdoutChunk = (chunk: Buffer) => {
        stdoutBuffer += chunk.toString()

        let newlineIndex = stdoutBuffer.indexOf('\n')
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, '')
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
          processLine(line)
          newlineIndex = stdoutBuffer.indexOf('\n')
        }
      }

      proc.stdout.on('data', processStdoutChunk)
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        if (stdoutBuffer.trim()) {
          processLine(stdoutBuffer.replace(/\r$/, ''))
        }

        const finalAssistantOutput = [...assistantMessageOrder]
          .reverse()
          .map((messageKey) => assistantMessages.get(messageKey)?.trim() ?? '')
          .find((message) => message.length > 0) ?? ''
        const output = finalAssistantOutput
          || sanitizePromptOutput(rawStdout)
          || stderr.trim()

        if (code !== 0 && !output) {
          reject(new Error(this.formatProcessFailure(
            agent,
            ['prompt', '-s', sessionName, text],
            code,
            rawStdout,
            stderr,
            ['--format', 'json', '--json-strict'],
          )))
        } else {
          resolve({
            output,
            events,
            ...(stopReason ? { stopReason } : {}),
            streamedAssistantText,
          })
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn acpx: ${err.message}. Is acpx installed?`))
      })
    })
  }

  private async promptTextMode(agent: string, sessionName: string, text: string): Promise<AcpResult> {
    const events: AcpEvent[] = []

    return await new Promise<AcpResult>((resolve, reject) => {
      // Old acpx builds may not support JSON output yet.
      const proc = spawn('acpx', this.buildAcpxArgs(agent, ['prompt', '-s', sessionName, text]), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.cwd,
        env: { ...process.env },
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        const output = sanitizePromptOutput(stdout) || stderr.trim()

        if (code !== 0 && !output) {
          reject(new Error(this.formatProcessFailure(
            agent,
            ['prompt', '-s', sessionName, text],
            code,
            stdout,
            stderr,
          )))
        } else {
          resolve({
            output,
            events,
            streamedAssistantText: false,
          })
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn acpx: ${err.message}. Is acpx installed?`))
      })
    })
  }

  /**
   * Cancel the current operation in a session.
   */
  async cancel(agent: string, sessionName: string): Promise<void> {
    await this.exec(agent, ['cancel', '-s', sessionName])
  }

  /**
   * Close a session.
   */
  async close(agent: string, sessionName: string): Promise<void> {
    await this.exec(agent, ['sessions', 'close', sessionName])
  }

  /**
   * Execute an acpx command and return stdout.
   */
  private exec(agent: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn('acpx', this.buildAcpxArgs(agent, args), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.cwd,
        env: { ...process.env },
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(this.formatProcessFailure(agent, args, code, stdout, stderr)))
        else resolve(stdout)
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn acpx: ${err.message}`))
      })
    })
  }
}
