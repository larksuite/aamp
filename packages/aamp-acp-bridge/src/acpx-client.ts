import { spawn } from 'node:child_process'

export interface AcpEvent {
  eventVersion?: number
  sessionId?: string
  requestId?: string
  seq?: number
  type?: string
  content?: string
  [key: string]: unknown
}

export interface AcpResult {
  output: string
  events: AcpEvent[]
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
  async prompt(agent: string, sessionName: string, text: string): Promise<AcpResult> {
    const events: AcpEvent[] = []

    return new Promise<AcpResult>((resolve, reject) => {
      // Use text format (default) — most reliable across acpx versions.
      // --approve-all prevents interactive permission prompts from blocking.
      const proc = spawn('acpx', ['--approve-all', agent, 'prompt', '-s', sessionName, text], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.cwd,
        env: { ...process.env },
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        // acpx text mode writes the agent's response to stdout.
        // Try to extract meaningful output from stdout, falling back to stderr.
        const output = stdout.trim() || stderr.trim()

        if (code !== 0 && !output) {
          reject(new Error(`acpx exited with code ${code}: ${stderr.trim()}`))
        } else {
          resolve({ output, events })
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
      const proc = spawn('acpx', ['--approve-all', agent, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.cwd,
        env: { ...process.env },
      })

      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(`acpx ${agent} ${args.join(' ')} failed (${code}): ${stderr.trim()}`))
        else resolve(stdout)
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn acpx: ${err.message}`))
      })
    })
  }
}
