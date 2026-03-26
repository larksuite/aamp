import type { TaskDispatch } from 'aamp-sdk'

/**
 * Convert an AAMP TaskDispatch into a prompt string for an ACP agent.
 */
export function buildPrompt(task: TaskDispatch): string {
  const parts = [
    `## AAMP Task`,
    ``,
    `Task ID: ${task.taskId}`,
    `From: ${task.from}`,
    `Title: ${task.title}`,
  ]

  if (task.bodyText) {
    parts.push(``, `Description:`, task.bodyText)
  }

  if (task.timeoutSecs) {
    parts.push(``, `Deadline: ${task.timeoutSecs}s`)
  }

  parts.push(
    ``,
    `Please complete this task and output your result directly.`,
    `If you cannot complete the task and need more information, start your response with "HELP:" followed by your question.`,
    ``,
    `If you create any files as part of this task, list each file path at the end of your response in this exact format:`,
    `FILE:/absolute/path/to/file`,
  )

  return parts.join('\n')
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
  const trimmed = output.trim()
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
