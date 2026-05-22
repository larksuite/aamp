#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { AampClient } from 'aamp-sdk'
import { AampCliBridge } from './bridge.js'
import { BUILTIN_CLI_PROFILES, getBuiltinCliProfileNames } from './cli-profiles.js'
import { renderPairingCode, runInit } from './cli/init.js'
import { runProfileMaker } from './cli/profile-maker.js'
import { loadConfig, type AgentConfig, type BridgeConfig } from './config.js'
import { resolvePairingFile } from './pairing.js'
import { getDefaultProfilesDir, resolveConfigPath, resolveCredentialsFile } from './storage.js'

const args = process.argv.slice(2)
const command = args[0] ?? 'start'
const configPath = resolveConfigPath(
  args.includes('--config') ? (args[args.indexOf('--config') + 1] ?? '') : undefined,
)

function getOptionValue(flag: string): string | undefined {
  const idx = args.indexOf(flag)
  return idx >= 0 ? args[idx + 1] : undefined
}

function getAgent(config: BridgeConfig, agentName: string): AgentConfig {
  const agent = config.agents.find((item) => item.name === agentName)
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found in config`)
  }
  return agent
}

function loadAgentCredentials(agent: AgentConfig): { email: string; smtpPassword: string } {
  const credFile = resolveCredentialsFile(agent.credentialsFile, agent.name)
  const creds = JSON.parse(readFileSync(credFile, 'utf-8')) as {
    email?: string
    smtpPassword?: string
  }

  if (!creds.email || !creds.smtpPassword) {
    throw new Error(`Credentials file is incomplete: ${credFile}`)
  }

  return {
    email: creds.email,
    smtpPassword: creds.smtpPassword,
  }
}

function createDirectoryClient(configPathValue: string, agentName: string): AampClient {
  const config = loadConfig(configPathValue)
  const agent = config.agents.find((item) => item.name === agentName)
  if (!agent) {
    throw new Error(`Agent "${agentName}" not found in ${configPathValue}`)
  }

  const creds = loadAgentCredentials(agent)

  return AampClient.fromMailboxIdentity({
    email: creds.email,
    smtpPassword: creds.smtpPassword,
    baseUrl: config.aampHost,
    rejectUnauthorized: config.rejectUnauthorized,
  })
}

function renderPairingForAgent(configPathValue: string, agentName: string): void {
  const config = loadConfig(configPathValue)
  const agent = getAgent(config, agentName)
  const creds = loadAgentCredentials(agent)
  renderPairingCode(
    agent.name,
    creds.email,
    resolvePairingFile(agent.pairingFile, agent.name),
  )
}

async function startBridge(
  configPathValue: string,
  options: { quiet?: boolean; agent?: string } = {},
): Promise<void> {
  const config = loadConfig(configPathValue)
  const agents = options.agent ? [getAgent(config, options.agent)] : config.agents
  const bridge = new AampCliBridge({
    ...config,
    agents,
  })

  const shutdown = () => {
    console.log('\nShutting down...')
    bridge.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  await bridge.start({ quiet: options.quiet })
  setInterval(() => {}, 60_000)
}

async function main() {
  switch (command) {
    case 'init': {
      const initialized = await runInit(configPath)
      if (!initialized) break
      if (args.includes('--no-start')) {
        console.log(`CLI bridge not started because --no-start was provided.`)
        console.log(`Run: npx aamp-cli-bridge start\n`)
        break
      }
      await startBridge(configPath, { quiet: true })
      break
    }

    case 'start': {
      await startBridge(configPath)
      break
    }

    case 'pair': {
      const agentName = getOptionValue('--agent')
      if (!agentName) throw new Error('Missing required --agent')
      renderPairingForAgent(configPath, agentName)
      if (args.includes('--no-start')) break
      await startBridge(configPath, { quiet: true, agent: agentName })
      break
    }

    case 'list': {
      const config = loadConfig(configPath)
      console.log(`\nConfigured CLI agents (${config.agents.length}):`)
      for (const agent of config.agents) {
        const credFile = resolveCredentialsFile(agent.credentialsFile, agent.name)
        let email = '(not registered)'
        try {
          const creds = JSON.parse(readFileSync(credFile, 'utf-8'))
          email = creds.email ?? email
        } catch { /* no credentials yet */ }
        const profile = typeof agent.cliProfile === 'string'
          ? agent.cliProfile
          : (agent.cliProfile.name ?? 'inline')
        console.log(`  ${agent.name}: ${email} (profile:${profile})`)
      }
      console.log()
      break
    }

    case 'status': {
      const config = loadConfig(configPath)
      const bridge = new AampCliBridge(config)
      await bridge.start()
      bridge.list()
      bridge.stop()
      break
    }

    case 'profile-list': {
      console.log('\nBuilt-in CLI profiles:')
      for (const name of getBuiltinCliProfileNames()) {
        const profile = BUILTIN_CLI_PROFILES[name]
        console.log(`  ${name}: ${profile.description ?? profile.command}`)
      }

      const profilesDir = getDefaultProfilesDir()
      console.log(`\nUser CLI profiles (${profilesDir}):`)
      if (!existsSync(profilesDir)) {
        console.log('  (none)')
      } else {
        const names = readdirSync(profilesDir)
          .filter((item) => item.endsWith('.json'))
          .map((item) => item.replace(/\.json$/, ''))
          .sort()
        if (names.length === 0) {
          console.log('  (none)')
        } else {
          for (const name of names) console.log(`  ${name}`)
        }
      }
      console.log()
      break
    }

    case 'profile-maker': {
      await runProfileMaker()
      break
    }

    case 'directory-list': {
      const agentName = getOptionValue('--agent')
      if (!agentName) throw new Error('Missing required --agent')
      const client = createDirectoryClient(configPath, agentName)
      const agents = await client.listDirectory({
        includeSelf: args.includes('--include-self'),
        limit: getOptionValue('--limit') ? Number(getOptionValue('--limit')) : undefined,
      })
      console.log(JSON.stringify({ agents }, null, 2))
      break
    }

    case 'directory-search': {
      const agentName = getOptionValue('--agent')
      const query = getOptionValue('--query')
      if (!agentName) throw new Error('Missing required --agent')
      if (!query) throw new Error('Missing required --query')
      const client = createDirectoryClient(configPath, agentName)
      const agents = await client.searchDirectory({
        query,
        includeSelf: args.includes('--include-self'),
        limit: getOptionValue('--limit') ? Number(getOptionValue('--limit')) : undefined,
      })
      console.log(JSON.stringify({ agents }, null, 2))
      break
    }

    case 'directory-update': {
      const agentName = getOptionValue('--agent')
      if (!agentName) throw new Error('Missing required --agent')
      const summary = getOptionValue('--summary')
      const cardText = getOptionValue('--card-text')
      const cardFile = getOptionValue('--card-file')
      const resolvedCardText = cardText ?? (cardFile ? readFileSync(cardFile, 'utf-8') : undefined)

      if (!summary && !resolvedCardText) {
        throw new Error('Provide at least one of --summary, --card-text, or --card-file')
      }

      const client = createDirectoryClient(configPath, agentName)
      const profile = await client.updateDirectoryProfile({
        ...(summary ? { summary } : {}),
        ...(resolvedCardText ? { cardText: resolvedCardText } : {}),
      })
      console.log(JSON.stringify({ profile }, null, 2))
      break
    }

    case 'help':
    default:
      console.log(`
AAMP CLI Bridge -- Connect direct CLI agents to the AAMP email network

Usage:
  aamp-cli-bridge init [--no-start]    Interactive setup wizard, then start bridge
  aamp-cli-bridge start [--config X]   Start the bridge (default: ~/.aamp/cli-bridge/config.json)
  aamp-cli-bridge pair --agent NAME [--config X] [--no-start]  Show a pairing QR code, then start that agent
  aamp-cli-bridge list  [--config X]   List configured agents
  aamp-cli-bridge status               Show live connection status
  aamp-cli-bridge profile-list         List built-in and user CLI profiles
  aamp-cli-bridge profile-maker        Interactive profile maker for custom CLI agents
  aamp-cli-bridge directory-list --agent NAME [--config X] [--include-self] [--limit N]
  aamp-cli-bridge directory-search --agent NAME --query TEXT [--config X] [--include-self] [--limit N]
  aamp-cli-bridge directory-update --agent NAME [--config X] [--summary TEXT] [--card-text TEXT] [--card-file PATH]
  aamp-cli-bridge help                 Show this help

Examples:
  npx aamp-cli-bridge profile-maker
  npx aamp-cli-bridge init
  npx aamp-cli-bridge init --no-start
  npx aamp-cli-bridge pair --agent codex
  npx aamp-cli-bridge start
  npx aamp-cli-bridge start --config production.json
`)
      break
  }
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`)
  process.exit(1)
})
