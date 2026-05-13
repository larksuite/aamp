import type { TaskDispatch } from 'aamp-sdk'

function isConversationalTask(task: TaskDispatch): boolean {
  const source = task.dispatchContext?.source?.trim().toLowerCase()
  return source === 'feishu' || source === 'wechat'
}

function isCliTranscriptHeader(line: string): boolean {
  return /^\[(client|tool|done|error|warning)\](?:\s|$)/i.test(line)
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

export function buildPrompt(task: TaskDispatch, threadContextText?: string): string {
  const dispatchContextLines = task.dispatchContext && Object.keys(task.dispatchContext).length > 0
    ? `Dispatch Context:\n${Object.entries(task.dispatchContext).map(([key, value]) => `  - ${key}: ${value}`).join('\n')}`
    : ''

  const parts = isConversationalTask(task)
    ? [
        `## AAMP Conversation Turn`,
        ``,
        `This task came from a chat surface (${task.dispatchContext?.source ?? 'unknown'}).`,
        `Treat it as an ongoing conversation turn, not a ticket or work order.`,
        `Reply naturally to the user's latest message and keep the conversation moving.`,
        ``,
        `Task ID: ${task.taskId}`,
        `From: ${task.from}`,
        `Title: ${task.title}`,
        `Priority: ${task.priority}`,
        dispatchContextLines,
        task.bodyText ? `Latest user message:\n${task.bodyText}` : '',
        threadContextText?.trim() ? threadContextText : '',
        task.expiresAt ? `Expires At: ${task.expiresAt}` : '',
        ``,
        `Execution rules:`,
        `- Treat the latest user message and prior thread context as the only conversation context.`,
        `- Only start your response with "HELP:" when you are truly blocked and need specific missing information.`,
        `- Keep your final reply limited to the final user-facing message.`,
        `- Do not include tool logs or intermediate progress updates in the final reply.`,
        ``,
        `If you create files, list each file path at the end in this exact format:`,
        `FILE:/absolute/path/to/file`,
      ]
    : [
        `## AAMP Task`,
        ``,
        `Task ID: ${task.taskId}`,
        `From: ${task.from}`,
        `Title: ${task.title}`,
        `Priority: ${task.priority}`,
        dispatchContextLines,
        task.bodyText ? `Description:\n${task.bodyText}` : '',
        threadContextText?.trim() ? threadContextText : '',
        task.expiresAt ? `Expires At: ${task.expiresAt}` : '',
        ``,
        `Execution rules:`,
        `- Treat the Description section and prior thread context as the only task context.`,
        `- If you need more information, start your response with "HELP:" followed by your question.`,
        `- Keep your final reply limited to the final user-facing result.`,
        `- Do not include tool logs or intermediate progress updates in the final reply.`,
        ``,
        `If you create files, list each file path at the end in this exact format:`,
        `FILE:/absolute/path/to/file`,
      ]

  return parts.filter(Boolean).join('\n')
}

export function parseResponse(output: string): {
  isHelp: boolean
  question?: string
  output: string
  files: string[]
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

  const files: string[] = []
  const outputLines: string[] = []
  for (const line of trimmed.split('\n')) {
    if (line.startsWith('FILE:')) {
      const path = line.slice(5).trim()
      if (path) files.push(path)
    } else {
      outputLines.push(line)
    }
  }

  return { isHelp: false, output: outputLines.join('\n').trim(), files }
}
