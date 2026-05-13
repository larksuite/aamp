export interface CliStreamEvent {
  type: string
  data?: unknown
  raw?: string
}

export interface ParsedCliStreamUpdate {
  event: CliStreamEvent
  textDelta?: string
  finalText?: string
}

function parseJsonData(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return trimmed
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function firstString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function normalizeEventType(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function normalizeCliStreamEvent(event: CliStreamEvent): ParsedCliStreamUpdate {
  const record = asRecord(event.data)
  const type = event.type

  const textDelta = firstString(record, ['delta', 'text_delta', 'textDelta', 'content_delta'])
    ?? (['delta', 'text.delta'].includes(type) ? firstString(record, ['text', 'content', 'message']) : undefined)
    ?? (type === 'text' ? firstString(record, ['text', 'content', 'message']) : undefined)

  const finalText = ['result', 'final', 'output', 'message'].includes(type)
    ? firstString(record, ['output', 'text', 'content', 'message'])
    : undefined

  return {
    event,
    ...(textDelta ? { textDelta } : {}),
    ...(finalText ? { finalText } : {}),
  }
}

export class SseStreamParser {
  private buffer = ''
  private eventName = 'message'
  private dataLines: string[] = []

  push(chunk: string): ParsedCliStreamUpdate[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const updates: ParsedCliStreamUpdate[] = []

    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      const update = this.processLine(line)
      if (update) updates.push(update)
      newlineIndex = this.buffer.indexOf('\n')
    }

    return updates
  }

  flush(): ParsedCliStreamUpdate[] {
    const updates: ParsedCliStreamUpdate[] = []
    if (this.buffer.trim()) {
      const update = this.processLine(this.buffer)
      if (update) updates.push(update)
    }
    this.buffer = ''
    const finalUpdate = this.flushEvent()
    if (finalUpdate) updates.push(finalUpdate)
    return updates
  }

  private processLine(line: string): ParsedCliStreamUpdate | undefined {
    if (!line.trim()) {
      return this.flushEvent()
    }

    if (line.startsWith(':')) return undefined

    const separatorIndex = line.indexOf(':')
    if (separatorIndex < 0) return undefined

    const field = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).replace(/^ /, '')

    if (field === 'event') {
      this.eventName = value || 'message'
    } else if (field === 'data') {
      this.dataLines.push(value)
    }

    return undefined
  }

  private flushEvent(): ParsedCliStreamUpdate | undefined {
    if (this.dataLines.length === 0) {
      this.eventName = 'message'
      return undefined
    }

    const raw = this.dataLines.join('\n')
    const event: CliStreamEvent = {
      type: this.eventName,
      raw,
      data: parseJsonData(raw),
    }
    this.eventName = 'message'
    this.dataLines = []
    return normalizeCliStreamEvent(event)
  }
}

export class NdjsonStreamParser {
  private buffer = ''

  push(chunk: string): ParsedCliStreamUpdate[] {
    this.buffer += chunk.replace(/\r\n/g, '\n')
    const updates: ParsedCliStreamUpdate[] = []

    let newlineIndex = this.buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex)
      this.buffer = this.buffer.slice(newlineIndex + 1)
      const update = this.parseLine(line)
      if (update) updates.push(update)
      newlineIndex = this.buffer.indexOf('\n')
    }

    return updates
  }

  flush(): ParsedCliStreamUpdate[] {
    const update = this.parseLine(this.buffer)
    this.buffer = ''
    return update ? [update] : []
  }

  private parseLine(line: string): ParsedCliStreamUpdate | undefined {
    const trimmed = line.trim()
    if (!trimmed) return undefined

    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return undefined
    }

    const record = asRecord(parsed)
    const type = normalizeEventType(record?.event)
      ?? normalizeEventType(record?.type)
      ?? normalizeEventType(record?.name)
      ?? 'message'

    return normalizeCliStreamEvent({
      type,
      raw: trimmed,
      data: parsed,
    })
  }
}
