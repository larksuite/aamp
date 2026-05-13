import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { createInterface } from 'node:readline'
import type { CliProfileDefinition } from '../config.js'
import { CliAgentClient } from '../cli-agent-client.js'
import { getDefaultProfilePath, getDefaultProfilesDir } from '../storage.js'

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

function splitArgs(input: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaped = false

  for (const char of input) {
    if (escaped) {
      current += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current) args.push(current)
  return args
}

function sanitizeProfileName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export async function runProfileMaker(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('\nAAMP CLI Profile Maker\n')
  console.log('Use {{prompt}} where the AAMP task prompt should be inserted.')
  console.log('Available templates: {{agentName}}, {{sessionKey}}, {{prompt}}, {{env.NAME}}\n')

  const rawName = await ask(rl, '? Profile name: ')
  const name = sanitizeProfileName(rawName)
  if (!name) {
    rl.close()
    throw new Error('Profile name is required')
  }

  const command = (await ask(rl, '? Command (example: my-agent): ')).trim()
  if (!command) {
    rl.close()
    throw new Error('Command is required')
  }

  const description = (await ask(rl, '? Description (optional): ')).trim()
  const mode = (await ask(rl, '? Prompt delivery: argument, stdin, or none? (default: argument): ')).trim().toLowerCase() || 'argument'
  const argsInput = await ask(
    rl,
    mode === 'argument'
      ? '? Args template (default: {{prompt}}): '
      : '? Args template (optional): ',
  )

  const args = argsInput.trim()
    ? splitArgs(argsInput)
    : mode === 'argument'
      ? ['{{prompt}}']
      : []

  let stdin: string | undefined
  if (mode === 'stdin') {
    const stdinInput = await ask(rl, '? Stdin template (default: {{prompt}}): ')
    stdin = stdinInput.trim() || '{{prompt}}'
  } else if (mode !== 'argument' && mode !== 'none') {
    rl.close()
    throw new Error('Prompt delivery must be argument, stdin, or none')
  }

  const cwd = (await ask(rl, '? Working directory template (optional): ')).trim()
  const streamFormatInput = (await ask(rl, '? Stream parser: none, sse, or ndjson? (default: none): ')).trim().toLowerCase()
  const streamFormat = streamFormatInput === 'sse' || streamFormatInput === 'ndjson'
    ? streamFormatInput
    : undefined
  const timeoutInput = (await ask(rl, '? Timeout milliseconds (default: 1800000): ')).trim()
  const timeoutMs = timeoutInput ? Number(timeoutInput) : 1_800_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    rl.close()
    throw new Error('Timeout must be a positive integer')
  }

  const profile: CliProfileDefinition = {
    name,
    ...(description ? { description } : {}),
    command,
    ...(args.length ? { args } : {}),
    ...(stdin ? { stdin } : {}),
    ...(cwd ? { cwd } : {}),
    ...(streamFormat ? { stream: { format: streamFormat } } : {}),
    timeoutMs,
  }

  const shouldTest = (await ask(rl, '? Run a smoke test now? (y/N): ')).trim().toLowerCase() === 'y'
  if (shouldTest) {
    const testPrompt = (await ask(rl, '? Test prompt (default: Say OK): ')).trim() || 'Say OK'
    const result = await new CliAgentClient(profile, name).prompt(`profile-test-${Date.now()}`, testPrompt)
    console.log('\n--- Test output ---')
    console.log(result.output || '(no output)')
    console.log('--- End test output ---\n')
  }

  const profilePath = getDefaultProfilePath(name)
  if (existsSync(profilePath)) {
    const overwrite = (await ask(rl, `? ${profilePath} exists. Overwrite? (y/N): `)).trim().toLowerCase()
    if (overwrite !== 'y') {
      rl.close()
      console.log('Profile not written.')
      return
    }
  }

  mkdirSync(dirname(profilePath), { recursive: true })
  writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`)

  console.log(`Profile written to ${profilePath}`)
  console.log(`Reference it from an agent config with: "cliProfile": "${name}"`)
  console.log(`Profiles directory: ${getDefaultProfilesDir()}\n`)

  rl.close()
}
