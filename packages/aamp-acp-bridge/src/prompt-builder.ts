import type { TaskDispatch } from 'aamp-sdk'

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

function isConversationalTask(task: TaskDispatch): boolean {
  const source = task.dispatchContext?.source?.trim().toLowerCase()
  return source === 'feishu' || source === 'wechat'
}

/**
 * Convert an AAMP TaskDispatch into a prompt string for an ACP agent.
 */
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
        `Behavior rules:`,
        `- A normal conversational reply is the default.`,
        `- Greetings, acknowledgements, short follow-up questions, and direct answers are all valid replies.`,
        `- Do not ask for clarification just because the user message is short or casual.`,
        `- Only start your response with "HELP:" when you are truly blocked and cannot produce any meaningful reply without specific missing information.`,
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
        `- Treat the Latest user message section and any prior thread context below as the only conversation context you were given.`,
        `- If that context does not contain the actual user request or is otherwise insufficient, respond with HELP instead of trying to reconstruct intent from local files, account state, or remote services.`,
        `- Do not search outside the current working directory unless the user message explicitly asks you to inspect a specific external path.`,
        `- Do not inspect the filesystem, credentials, mailbox state, home directory, or network just to guess what the user probably meant.`,
        `- For simple chat messages that are fully present in the prompt, answer them directly without workspace exploration.`,
        ``,
        `Keep your final reply limited to the final user-facing message.`,
        `Do not include planning notes, thought process, tool logs, or intermediate progress updates in the final reply.`,
        ``,
        `If you create any files as part of this task, list each file path at the end of your response in this exact format:`,
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

  return { isHelp: false, output: outputLines.join('\n').trim(), files }
}
