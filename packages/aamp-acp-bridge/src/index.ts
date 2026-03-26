#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { AampAcpBridge } from './bridge.js'
import { runInit } from './cli/init.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'start'
const configPath = args.includes('--config')
  ? (args[args.indexOf('--config') + 1] ?? 'bridge.json')
  : 'bridge.json'

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

async function main() {
  switch (command) {
    case 'init': {
      await runInit(configPath)
      break
    }

    case 'start': {
      const config = loadConfig(configPath)
      const bridge = new AampAcpBridge(config)

      // Graceful shutdown
      const shutdown = () => {
        console.log('\nShutting down...')
        bridge.stop()
        process.exit(0)
      }
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)

      await bridge.start()

      // Keep alive
      setInterval(() => {}, 60_000)
      break
    }

    case 'list': {
      const config = loadConfig(configPath)
      console.log(`\nConfigured agents (${config.agents.length}):`)
      for (const a of config.agents) {
        const credFile = resolveCredentialsFile(a.credentialsFile, a.name)
        let email = '(not registered)'
        try {
          const creds = JSON.parse(readFileSync(credFile, 'utf-8'))
          email = creds.email ?? email
        } catch { /* no credentials yet */ }
        console.log(`  ${a.name}: ${email} (${a.acpCommand})`)
      }
      console.log()
      break
    }

    case 'status': {
      const config = loadConfig(configPath)
      const bridge = new AampAcpBridge(config)
      await bridge.start()
      bridge.list()
      bridge.stop()
      break
    }

    case 'help':
    default:
      console.log(`
AAMP ACP Bridge -- Connect ACP agents to the AAMP email network

Usage:
  aamp-acp-bridge init                 Interactive setup wizard
  aamp-acp-bridge start [--config X]   Start the bridge (default: bridge.json)
  aamp-acp-bridge list  [--config X]   List configured agents
  aamp-acp-bridge status               Show live connection status
  aamp-acp-bridge help                 Show this help

Examples:
  npx aamp-acp-bridge init
  npx aamp-acp-bridge start
  npx aamp-acp-bridge start --config production.json
`)
      break
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`)
  process.exit(1)
})
