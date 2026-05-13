import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CliProfileDefinition } from './config.js'
import {
  NdjsonStreamParser,
  SseStreamParser,
  type CliStreamEvent,
  type ParsedCliStreamUpdate,
} from './stream-parser.js'

export interface CliPromptContext {
  agentName: string
  sessionKey?: string
  prompt: string
}

export interface CliRunResult {
  output: string
  streamedText: boolean
  events: CliStreamEvent[]
}

export interface CliPromptHandlers {
  onStreamUpdate?: (update: ParsedCliStreamUpdate) => void
}

function expandHomePath(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function renderTemplate(value: string, context: CliPromptContext): string {
  return value.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    switch (key) {
      case 'agentName':
        return context.agentName
      case 'sessionKey':
        return context.sessionKey ?? ''
      case 'prompt':
        return context.prompt
      default:
        if (key.startsWith('env.')) {
          return process.env[key.slice(4)] ?? ''
        }
        return match
    }
  })
}

function renderRecord(
  record: Record<string, string> | undefined,
  context: CliPromptContext,
): Record<string, string> {
  if (!record) return {}
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, renderTemplate(value, context)]),
  )
}

function formatOutput(stdout: string, stderr: string, profile: CliProfileDefinition): string {
  const options = profile.output ?? {}
  const chunks = [stdout]
  if (options.includeStderr) chunks.push(stderr)

  let output = chunks.join(options.includeStderr && stdout && stderr ? '\n' : '')
  if (options.stripAnsi !== false) output = stripAnsi(output)
  if (options.trim !== false) output = output.trim()
  return output
}

export class CliAgentClient {
  constructor(
    private readonly profile: CliProfileDefinition,
    private readonly agentName: string,
  ) {}

  async prompt(
    sessionKey: string | undefined,
    text: string,
    handlers?: CliPromptHandlers,
  ): Promise<CliRunResult> {
    const context: CliPromptContext = {
      agentName: this.agentName,
      sessionKey,
      prompt: text,
    }
    const command = renderTemplate(this.profile.command, context)
    const args = (this.profile.args ?? []).map((arg) => renderTemplate(arg, context))
    const stdin = this.profile.stdin == null ? undefined : renderTemplate(this.profile.stdin, context)
    const successExitCodes = new Set(this.profile.successExitCodes ?? [0])
    const timeoutMs = this.profile.timeoutMs ?? 1_800_000
    const streamParser = this.profile.stream?.format === 'sse'
      ? new SseStreamParser()
      : this.profile.stream?.format === 'ndjson'
        ? new NdjsonStreamParser()
        : null
    const streamEnabled = this.profile.stream?.enabled !== false && Boolean(streamParser)

    return await new Promise<CliRunResult>((resolve, reject) => {
      const proc = spawn(command, args, {
        cwd: this.profile.cwd ? expandHomePath(renderTemplate(this.profile.cwd, context)) : process.cwd(),
        env: {
          ...process.env,
          ...renderRecord(this.profile.env, context),
          ...(sessionKey ? { AAMP_SESSION_KEY: sessionKey } : {}),
        },
        shell: this.profile.shell ?? false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let streamedOutput = ''
      let finalStreamOutput = ''
      const events: CliStreamEvent[] = []

      const processStreamUpdates = (updates: ParsedCliStreamUpdate[]) => {
        for (const update of updates) {
          events.push(update.event)
          if (update.textDelta) streamedOutput += update.textDelta
          if (update.finalText) finalStreamOutput = update.finalText
          handlers?.onStreamUpdate?.(update)
        }
      }

      const timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL')
        }, 2_000).unref()
      }, timeoutMs)
      timer.unref()

      proc.stdout.on('data', (chunk: Buffer) => {
        const textChunk = chunk.toString()
        stdout += textChunk
        if (streamEnabled && streamParser) {
          processStreamUpdates(streamParser.push(textChunk))
        }
      })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        clearTimeout(timer)
        if (timedOut) {
          reject(new Error(`CLI profile "${this.profile.name ?? this.agentName}" timed out after ${timeoutMs}ms`))
          return
        }

        const output = formatOutput(stdout, stderr, this.profile)
        if (streamEnabled && streamParser) {
          processStreamUpdates(streamParser.flush())
        }
        const streamOutput = finalStreamOutput || streamedOutput
        const exitCode = code ?? 0
        if (!successExitCodes.has(exitCode)) {
          reject(new Error(
            `CLI profile "${this.profile.name ?? this.agentName}" exited with code ${exitCode}: ${stderr.trim() || output || 'no output'}`,
          ))
          return
        }

        resolve({
          output: streamOutput || output,
          streamedText: Boolean(streamOutput),
          events,
        })
      })

      proc.on('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`Failed to spawn CLI profile "${this.profile.name ?? this.agentName}": ${err.message}`))
      })

      if (stdin != null) {
        proc.stdin.write(stdin)
      }
      proc.stdin.end()
    })
  }
}
