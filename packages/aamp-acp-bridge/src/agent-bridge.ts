import { AampClient, type TaskDispatch, type AampAttachment } from 'aamp-sdk'
import { AcpxClient } from './acpx-client.js'
import { buildPrompt, parseResponse } from './prompt-builder.js'
import type { AgentConfig } from './config.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

export interface AgentIdentity {
  email: string
  jmapToken: string
  smtpPassword: string
}

function defaultCredentialsFile(name: string): string {
  return join(homedir(), '.acp-bridge', `.aamp-${name}.json`)
}

function resolveCredentialsFile(pathValue: string | undefined, name: string): string {
  const raw = pathValue?.trim()
  if (!raw) return defaultCredentialsFile(name)
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * Bridges a single ACP agent to the AAMP network.
 * Manages AAMP identity, ACP session, and task routing.
 */
export class AgentBridge {
  private client: AampClient | null = null
  private acpx: AcpxClient
  private identity: AgentIdentity | null = null
  private sessionName: string
  private processing = false
  private pollingFallback = false
  private transportMode: 'connecting' | 'websocket' | 'polling' | 'disconnected' = 'connecting'

  constructor(
    private readonly agentConfig: AgentConfig,
    private readonly aampHost: string,
    private readonly rejectUnauthorized: boolean,
  ) {
    this.acpx = new AcpxClient()
    this.sessionName = `aamp-${agentConfig.name}`
  }

  get name(): string { return this.agentConfig.name }
  get email(): string { return this.identity?.email ?? '(not registered)' }
  get isConnected(): boolean { return this.client?.isConnected() ?? false }
  get isUsingPollingFallback(): boolean { return this.pollingFallback || (this.client?.isUsingPollingFallback() ?? false) }
  get isBusy(): boolean { return this.processing }

  /**
   * Start the bridge: resolve identity → connect AAMP → ensure ACP session.
   */
  async start(): Promise<void> {
    // 1. Resolve AAMP identity
    this.identity = await this.resolveIdentity()
    console.log(`[${this.name}] AAMP identity: ${this.identity.email}`)

    // 2. Create AAMP client
    const smtpUrl = new URL(this.aampHost)
    this.client = new AampClient({
      email: this.identity.email,
      jmapToken: this.identity.jmapToken,
      jmapUrl: this.aampHost,
      smtpHost: smtpUrl.hostname,
      smtpPort: 587,
      smtpPassword: this.identity.smtpPassword,
      rejectUnauthorized: this.rejectUnauthorized,
    })

    // 3. Wire up task handler
    this.client.on('task.dispatch', (task: TaskDispatch) => {
      this.handleTask(task).catch((err) => {
        console.error(`[${this.name}] Task ${task.taskId} failed: ${(err as Error).message}`)
      })
    })

    this.client.on('connected', () => {
      const usingPollingFallback = this.client?.isUsingPollingFallback() ?? false
      this.pollingFallback = usingPollingFallback
      if (usingPollingFallback) {
        if (this.transportMode !== 'polling') {
          console.warn(`[${this.name}] AAMP connected (polling fallback active)`)
        }
        this.transportMode = 'polling'
      } else {
        const previousMode = this.transportMode
        this.transportMode = 'websocket'
        if (previousMode === 'polling') {
          console.log(`[${this.name}] AAMP WebSocket restored`)
        } else {
          console.log(`[${this.name}] AAMP connected`)
        }
      }
    })

    this.client.on('disconnected', (reason: string) => {
      const usingPollingFallback = this.client?.isUsingPollingFallback() ?? false
      this.pollingFallback = usingPollingFallback
      if (usingPollingFallback) {
        if (this.transportMode !== 'polling') {
          console.warn(`[${this.name}] AAMP WebSocket unavailable, using polling fallback: ${reason}`)
        }
        this.transportMode = 'polling'
      } else {
        this.transportMode = 'disconnected'
        console.warn(`[${this.name}] AAMP disconnected: ${reason}`)
      }
    })

    this.client.on('error', (err: Error) => {
      if (err.message.includes('falling back to polling')) {
        this.pollingFallback = true
        if (this.transportMode !== 'polling') {
          console.warn(`[${this.name}] ${err.message}`)
          this.transportMode = 'polling'
        }
        return
      }
      if (this.transportMode === 'polling' && (
        err.message.includes('JMAP WebSocket handshake failed')
        || err.message.includes('Failed to get JMAP session')
        || err.message.includes('Polling fallback failed')
      )) {
        return
      }
      console.error(`[${this.name}] AAMP error: ${err.message}`)
    })

    // 4. Connect to AAMP
    await this.client.connect()

    // 5. Ensure ACP session
    try {
      await this.acpx.ensureSession(this.agentConfig.acpCommand, this.sessionName)
      console.log(`[${this.name}] ACP session ready: ${this.sessionName}`)
    } catch (err) {
      console.warn(`[${this.name}] ACP session setup deferred: ${(err as Error).message}`)
    }
  }

  /**
   * Stop the bridge.
   */
  stop(): void {
    this.client?.disconnect()
    this.client = null
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase()
  }

  private isSenderAllowed(sender: string): boolean {
    const whitelist = this.agentConfig.senderWhitelist
    if (!whitelist) return true
    const normalizedSender = this.normalizeEmail(sender)
    return whitelist.some((allowed) => this.normalizeEmail(allowed) === normalizedSender)
  }

  /**
   * Handle an incoming AAMP task by forwarding to the ACP agent.
   */
  private async handleTask(task: TaskDispatch): Promise<void> {
    if (!this.client) return

    console.log(`[${this.name}] <- task.dispatch  ${task.taskId}  "${task.title}"  from=${task.from}`)

    if (!this.isSenderAllowed(task.from)) {
      console.warn(
        `[${this.name}] Rejecting task ${task.taskId} from non-whitelisted sender: ${task.from}`,
      )
      await this.client.sendResult({
        to: task.from,
        taskId: task.taskId,
        status: 'rejected',
        output: '',
        errorMsg: 'Unauthorized sender: this bridge only accepts tasks from whitelisted email addresses.',
        inReplyTo: task.messageId,
      })
      return
    }

    this.processing = true

    try {
      const prompt = buildPrompt(task)
      const result = await this.acpx.prompt(this.agentConfig.acpCommand, this.sessionName, prompt)
      const parsed = parseResponse(result.output)

      if (parsed.isHelp) {
        // Agent needs help
        await this.client.sendHelp({
          to: task.from,
          taskId: task.taskId,
          question: parsed.question ?? 'Agent needs more information',
          blockedReason: 'ACP agent requested clarification',
          suggestedOptions: [],
          inReplyTo: task.messageId,
        })
        console.log(`[${this.name}] -> task.help  ${task.taskId}`)
      } else {
        // Collect file attachments referenced by the agent
        const attachments: AampAttachment[] = []
        for (const filepath of parsed.files) {
          if (existsSync(filepath)) {
            try {
              attachments.push({
                filename: basename(filepath),
                contentType: 'application/octet-stream',
                content: readFileSync(filepath),
              })
              console.log(`[${this.name}] Attaching file: ${filepath}`)
            } catch (err) {
              console.warn(`[${this.name}] Failed to read file ${filepath}: ${(err as Error).message}`)
            }
          }
        }

        // Task completed
        await this.client.sendResult({
          to: task.from,
          taskId: task.taskId,
          status: 'completed',
          output: parsed.output,
          inReplyTo: task.messageId,
          attachments: attachments.length > 0 ? attachments : undefined,
        })
        console.log(`[${this.name}] -> task.result  ${task.taskId}  completed${attachments.length ? ` (${attachments.length} attachment(s))` : ''}`)
      }
    } catch (err) {
      const errorMsg = (err as Error).message
      console.error(`[${this.name}] Task ${task.taskId} error: ${errorMsg}`)
      try {
        await this.client.sendResult({
          to: task.from,
          taskId: task.taskId,
          status: 'rejected',
          output: '',
          errorMsg: `ACP agent error: ${errorMsg}`,
          inReplyTo: task.messageId,
        })
      } catch { /* best effort */ }
    } finally {
      this.processing = false
    }
  }

  /**
   * Resolve AAMP identity: load from credentials file or register new.
   */
  private async resolveIdentity(): Promise<AgentIdentity> {
    const credFile = resolveCredentialsFile(this.agentConfig.credentialsFile, this.agentConfig.name)

    // Try loading existing credentials
    if (existsSync(credFile)) {
      try {
        const data = JSON.parse(readFileSync(credFile, 'utf-8'))
        if (data.email && data.jmapToken && data.smtpPassword) {
          return data as AgentIdentity
        }
      } catch { /* re-register */ }
    }

    // Self-register
    const slug = this.agentConfig.slug ?? `${this.agentConfig.name}-bridge`
    const description = this.agentConfig.description ?? `${this.agentConfig.name} via ACP bridge`

    // Step 1: Register
    const regRes = await fetch(`${this.aampHost}/api/nodes/self-register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, description }),
    })
    if (!regRes.ok) throw new Error(`Registration failed: ${regRes.status} ${await regRes.text()}`)
    const regData = await regRes.json() as { registrationCode: string; email: string }

    // Step 2: Exchange code for credentials
    const credRes = await fetch(`${this.aampHost}/api/nodes/credentials?code=${regData.registrationCode}`)
    if (!credRes.ok) throw new Error(`Credential exchange failed: ${credRes.status}`)
    const creds = await credRes.json() as { email: string; jmap: { token: string }; smtp: { password: string } }

    const identity: AgentIdentity = {
      email: creds.email,
      jmapToken: creds.jmap.token,
      smtpPassword: creds.smtp.password,
    }

    // Persist credentials
    mkdirSync(dirname(credFile), { recursive: true })
    writeFileSync(credFile, JSON.stringify(identity, null, 2))
    console.log(`[${this.name}] Registered: ${identity.email} (credentials saved to ${credFile})`)

    return identity
  }
}
