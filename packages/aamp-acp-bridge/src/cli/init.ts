import { createInterface } from 'node:readline'
import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AgentConfig, BridgeConfig } from '../config.js'

const KNOWN_AGENTS = [
  'claude', 'codex', 'gemini', 'goose', 'openclaw',
  'opencode', 'cursor', 'copilot', 'kimi', 'kiro',
]

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

function parseWhitelist(input: string): string[] {
  return input
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
}

function detectAgent(name: string): string | null {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' })
    try {
      const version = execSync(`${name} --version 2>/dev/null || echo unknown`, { stdio: 'pipe' }).toString().trim().split('\n')[0]
      return version
    } catch {
      return 'installed'
    }
  } catch {
    return null
  }
}

function defaultCredentialsFile(name: string): string {
  return join(homedir(), '.acp-bridge', `.aamp-${name}.json`)
}

export async function runInit(configPath: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log('\nAAMP ACP Bridge Setup\n')

  // 1. AAMP host
  const aampHostInput = (await ask(rl, '? AAMP Service URL (default: https://meshmail.ai): ')).trim()
  const aampHost = aampHostInput || 'https://meshmail.ai'
  if (!aampHost) { rl.close(); throw new Error('AAMP host is required') }

  // Verify connectivity
  try {
    const res = await fetch(`${aampHost}/health`)
    if (res.ok) {
      const data = await res.json() as { service: string }
      console.log(`  Connected (${data.service})\n`)
    } else {
      console.log(`  Warning: Server responded with ${res.status}\n`)
    }
  } catch {
    console.log(`  Warning: Could not reach ${aampHost} -- continuing anyway\n`)
  }

  // 2. Scan for ACP agents
  console.log('? Scanning for ACP agents...')
  const detected: Array<{ name: string; version: string }> = []
  for (const name of KNOWN_AGENTS) {
    const version = detectAgent(name)
    if (version) {
      console.log(`  + ${name.padEnd(12)} (${version})`)
      detected.push({ name, version })
    } else {
      console.log(`  - ${name.padEnd(12)} (not installed)`)
    }
  }
  console.log()

  if (detected.length === 0) {
    console.log('No ACP agents found. Install an agent first (e.g. npm i -g @anthropic-ai/claude-code).')
    rl.close()
    return
  }

  // 3. Select agents
  const selected: string[] = []
  for (const { name } of detected) {
    const answer = await ask(rl, `? Bridge ${name}? (y/N): `)
    if (answer.trim().toLowerCase() === 'y') {
      selected.push(name)
    }
  }

  if (selected.length === 0) {
    console.log('No agents selected. Exiting.')
    rl.close()
    return
  }

  // 4. Register AAMP identities
  console.log('\n? Registering AAMP identities...')
  const agents: AgentConfig[] = []

  for (const name of selected) {
    const slug = `${name}-bridge`
    const credFile = defaultCredentialsFile(name)
    const whitelistAnswer = await ask(rl, `? Restrict ${name} to a sender whitelist? (y/N): `)
    let senderWhitelist: string[] | undefined
    if (whitelistAnswer.trim().toLowerCase() === 'y') {
      const whitelistInput = await ask(
        rl,
        `? Allowed sender emails for ${name} (comma-separated): `,
      )
      const parsed = parseWhitelist(whitelistInput)
      if (parsed.length === 0) {
        console.log(`  Warning: no valid whitelist entries provided; ${name} will accept all senders.`)
      } else {
        senderWhitelist = parsed
      }
    }

    if (existsSync(credFile)) {
      console.log(`  + ${name} -> using existing credentials (${credFile})`)
      agents.push({ name, acpCommand: name, slug, credentialsFile: credFile, senderWhitelist })
      continue
    }

    try {
      const discoveryRes = await fetch(`${aampHost}/.well-known/aamp`)
      if (!discoveryRes.ok) throw new Error(`Discovery: ${discoveryRes.status}`)
      const discovery = await discoveryRes.json() as { api?: { url?: string } }
      const apiUrl = discovery.api?.url
      if (!apiUrl) throw new Error('AAMP discovery did not return api.url')
      const apiBase = new URL(apiUrl, `${aampHost}/`).toString()

      const regRes = await fetch(`${apiBase}?action=aamp.mailbox.register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, description: `${name} via ACP bridge` }),
      })
      if (!regRes.ok) throw new Error(`${regRes.status}`)
      const regData = await regRes.json() as { registrationCode: string; email: string }

      const credRes = await fetch(`${apiBase}?action=aamp.mailbox.credentials&code=${encodeURIComponent(regData.registrationCode)}`)
      if (!credRes.ok) throw new Error(`Credential exchange: ${credRes.status}`)
      const creds = await credRes.json() as { email: string; mailbox: { token: string }; smtp: { password: string } }

      mkdirSync(dirname(credFile), { recursive: true })
      writeFileSync(credFile, JSON.stringify({
        email: creds.email,
        mailboxToken: creds.mailbox.token,
        smtpPassword: creds.smtp.password,
      }, null, 2))

      console.log(`  + ${name} -> ${creds.email}`)
      agents.push({
        name,
        acpCommand: name,
        slug,
        credentialsFile: credFile,
        description: `${name} via ACP bridge`,
        senderWhitelist,
      })
    } catch (err) {
      console.log(`  x ${name} -> registration failed: ${(err as Error).message}`)
    }
  }

  if (agents.length === 0) {
    console.log('No agents registered. Exiting.')
    rl.close()
    return
  }

  // 5. Write config
  const config: BridgeConfig = { aampHost, rejectUnauthorized: false, agents }
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  console.log(`\nConfig written to ${configPath}`)
  console.log(`  Run: npx aamp-acp-bridge start\n`)

  rl.close()
}
