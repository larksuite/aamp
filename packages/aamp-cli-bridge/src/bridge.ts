import type { BridgeConfig } from './config.js'
import { AgentBridge } from './agent-bridge.js'

export class AampCliBridge {
  private agents = new Map<string, AgentBridge>()

  constructor(private readonly config: BridgeConfig) {}

  async start(): Promise<void> {
    console.log(`\nAAMP CLI Bridge`)
    console.log(`   Host: ${this.config.aampHost}`)
    console.log(`   Agents: ${this.config.agents.length}\n`)

    for (const agentConfig of this.config.agents) {
      const bridge = new AgentBridge(
        agentConfig,
        this.config.aampHost,
        this.config.rejectUnauthorized,
        this.config.profiles,
      )
      try {
        await bridge.start()
        this.agents.set(agentConfig.name, bridge)
      } catch (err) {
        console.error(`[${agentConfig.name}] Failed to start: ${(err as Error).message}`)
      }
    }

    if (this.agents.size === 0) {
      throw new Error('No agents started successfully')
    }

    console.log(`\nCLI bridge running with ${this.agents.size} agent(s):`)
    for (const [name, bridge] of this.agents) {
      console.log(`   ${name}: ${bridge.email}`)
    }
    console.log(`\nPress Ctrl+C to stop.\n`)
  }

  stop(): void {
    for (const [name, bridge] of this.agents) {
      console.log(`[${name}] Stopping...`)
      bridge.stop()
    }
    this.agents.clear()
  }

  list(): void {
    if (this.agents.size === 0) {
      console.log('No agents running.')
      return
    }
    console.log(`\nAgents (${this.agents.size}):`)
    for (const [name, bridge] of this.agents) {
      const status = bridge.isConnected
        ? (bridge.isUsingPollingFallback ? 'connected (polling fallback)' : 'connected')
        : 'disconnected'
      const busy = bridge.isBusy ? ' (processing)' : ''
      console.log(`  ${name}: ${bridge.email} -- ${status}${busy}`)
    }
    console.log()
  }
}
