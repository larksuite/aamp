#!/usr/bin/env node

import { inspect } from 'node:util'
import {
  ensureBridgeHomeDir,
  getBridgeHomeDir,
  initializeBridgeConfig,
  loadBridgeConfig,
  loadBridgeState,
} from './config.js'
import { FeishuBridgeRuntime } from './runtime.js'

type CommandName = 'init' | 'run' | 'status' | 'unknown'

interface ParsedArgs {
  command: CommandName
  values: Record<string, string[]>
  booleans: Set<string>
}

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv
  const command = (rawCommand ?? 'unknown') as CommandName
  const values: Record<string, string[]> = {}
  const booleans = new Set<string>()

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq > 2) {
      const key = token.slice(2, eq)
      const value = token.slice(eq + 1)
      values[key] = [...(values[key] ?? []), value]
      continue
    }
    const key = token.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith('--')) {
      booleans.add(key)
      continue
    }
    values[key] = [...(values[key] ?? []), next]
    index += 1
  }

  return { command, values, booleans }
}

function firstArg(args: ParsedArgs, key: string): string | undefined {
  return args.values[key]?.[0]
}

function printUsage(): void {
  console.log(`AAMP Feishu Bridge

Usage:
  aamp-feishu-bridge init [--config-dir DIR] [--aamp-host URL] [--target-agent EMAIL] [--app-id ID] [--app-secret SECRET] [--slug NAME] [--domain DOMAIN]
  aamp-feishu-bridge run [--config-dir DIR]
  aamp-feishu-bridge status [--config-dir DIR] [--json]
`)
}

async function runInit(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  await ensureBridgeHomeDir(configDir)
  const config = await initializeBridgeConfig({
    configDir,
    aampHost: firstArg(args, 'aamp-host'),
    targetAgentEmail: firstArg(args, 'target-agent'),
    appId: firstArg(args, 'app-id'),
    appSecret: firstArg(args, 'app-secret'),
    slug: firstArg(args, 'slug'),
    domain: firstArg(args, 'domain'),
  })

  console.log(`Initialized bridge in ${getBridgeHomeDir(configDir)}`)
  console.log(`AAMP mailbox: ${config.mailbox.email}`)
  console.log(`Target agent: ${config.targetAgentEmail}`)
}

async function runStatus(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  const config = await loadBridgeConfig(configDir)
  const state = await loadBridgeState(configDir)
  if (args.booleans.has('json')) {
    console.log(JSON.stringify({ config, state }, null, 2))
    return
  }
  if (!config) {
    console.log(`No bridge config found in ${getBridgeHomeDir(configDir)}.`)
    return
  }

  console.log(`Bridge home: ${getBridgeHomeDir(configDir)}`)
  console.log(`AAMP mailbox: ${config.mailbox.email}`)
  console.log(`Target agent: ${config.targetAgentEmail}`)
  console.log(`Feishu app: ${config.feishu.appId}`)
  console.log(`Connectivity: feishu=${state.connectivity.feishu} aamp=${state.connectivity.aamp}`)
  console.log(`Active conversations: ${Object.keys(state.conversations).length}`)
  console.log(`Tracked tasks: ${Object.keys(state.tasks).length}`)
  if (state.bot?.name || state.bot?.openId) {
    console.log(`Bot identity: ${state.bot.name || '(unknown)'} ${state.bot.openId ? `(${state.bot.openId})` : ''}`.trim())
  }
  if (state.lastError) {
    console.log(`Last error: ${state.lastError}`)
  }
}

async function runBridge(args: ParsedArgs): Promise<void> {
  const configDir = firstArg(args, 'config-dir')
  const config = await loadBridgeConfig(configDir)
  if (!config) {
    throw new Error(`No bridge config found in ${getBridgeHomeDir(configDir)}. Run "aamp-feishu-bridge init" first.`)
  }

  const runtime = new FeishuBridgeRuntime(config, { configDir })
  await runtime.start()
  console.log(`Feishu bridge is running for ${config.targetAgentEmail}`)
  console.log(`Mailbox: ${config.mailbox.email}`)

  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, shutting down...`)
    await runtime.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  switch (args.command) {
    case 'init':
      await runInit(args)
      return
    case 'run':
      await runBridge(args)
      return
    case 'status':
      await runStatus(args)
      return
    default:
      printUsage()
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : inspect(error))
  process.exitCode = 1
})
