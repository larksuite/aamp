import type { BridgeConfig } from './config.js'
import { AgentBridge } from './agent-bridge.js'

/**
 * Manages multiple ACP agent bridges, each with its own AAMP identity.
 */
export class AampAcpBridge {
  private agents = new Map<string, AgentBridge>()
  private config: BridgeConfig

  constructor(config: BridgeConfig) {
    this.config = config
  }

  /**
   * Start all configured agents.
   */
  async start(): Promise<void> {
    console.log(`\nAAMP ACP Bridge`)
    console.log(`   Host: ${this.config.aampHost}`)
    console.log(`   Agents: ${this.config.agents.length}\n`)

    for (const agentConfig of this.config.agents) {
      const bridge = new AgentBridge(agentConfig, this.config.aampHost, this.config.rejectUnauthorized)
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

    console.log(`\nBridge running with ${this.agents.size} agent(s):`)
    for (const [name, bridge] of this.agents) {
      console.log(`   ${name}: ${bridge.email}`)
    }
    console.log(`\nPress Ctrl+C to stop.\n`)
  }

  /**
   * Stop all agents.
   */
  stop(): void {
    for (const [name, bridge] of this.agents) {
      console.log(`[${name}] Stopping...`)
      bridge.stop()
    }
    this.agents.clear()
  }

  /**
   * List all agents and their status.
   */
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
