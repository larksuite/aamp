import type { AampThreadEvent } from './types.js'

export interface RenderThreadHistoryOptions {
  maxEvents?: number
}

function singleLine(value?: string | null, maxLength = 220): string {
  const normalized = (value ?? '').replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

function formatTimestamp(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().slice(0, 16).replace('T', ' ')
}

function renderEventLine(event: AampThreadEvent): string {
  const from = event.from.split('@')[0] || event.from
  const timestamp = formatTimestamp(event.createdAt)

  if (event.intent === 'task.dispatch') {
    const summary = singleLine(event.bodyText) || singleLine(event.title) || 'Task dispatched'
    return `[${timestamp}] ${from} dispatched: ${summary}`
  }

  if (event.intent === 'task.help_needed') {
    const question = singleLine(event.question) || 'Asked for help'
    const reason = singleLine(event.blockedReason)
    return `[${timestamp}] ${from} asked for help: ${question}${reason ? ` (reason: ${reason})` : ''}`
  }

  if (event.intent === 'task.result') {
    const output = singleLine(event.output) || singleLine(event.bodyText) || 'Sent a result'
    return `[${timestamp}] ${from} replied: ${output}`
  }

  if (event.intent === 'task.cancel') {
    const body = singleLine(event.bodyText) || 'Cancelled the task'
    return `[${timestamp}] ${from} cancelled the task: ${body}`
  }

  if (event.intent === 'task.ack') {
    return `[${timestamp}] ${from} acknowledged the task`
  }

  return `[${timestamp}] ${from}: ${singleLine(event.bodyText) || event.intent}`
}

export function renderThreadHistoryForAgent(
  events: AampThreadEvent[],
  options: RenderThreadHistoryOptions = {},
): string {
  const filtered = events.filter((event) => event.intent !== 'task.stream.opened')
  if (filtered.length === 0) return ''

  const maxEvents = Math.max(1, options.maxEvents ?? 8)
  const visible = filtered.slice(-maxEvents)
  const omitted = filtered.length - visible.length

  return [
    'Prior thread context:',
    ...(omitted > 0 ? [`(${omitted} earlier event(s) omitted)`] : []),
    ...visible.map((event) => `- ${renderEventLine(event)}`),
  ].join('\n')
}
