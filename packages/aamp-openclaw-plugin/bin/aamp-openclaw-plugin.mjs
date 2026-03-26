#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output, stderr } from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PLUGIN_ID = 'aamp-openclaw-plugin'
const DEFAULT_AAMP_HOST = 'https://meshmail.ai'
const DEFAULT_CREDENTIALS_FILE = '~/.openclaw/extensions/aamp-openclaw-plugin/.credentials.json'

function resolveOpenClawHome() {
  return process.env.OPENCLAW_HOME?.trim() || join(homedir(), '.openclaw')
}

function resolveOpenClawConfigPath() {
  return join(resolveOpenClawHome(), 'openclaw.json')
}

function resolveExtensionDir() {
  return join(resolveOpenClawHome(), 'extensions', PLUGIN_ID)
}

function expandHome(pathValue) {
  if (!pathValue) return pathValue
  if (pathValue === '~') return homedir()
  if (pathValue.startsWith('~/')) return join(homedir(), pathValue.slice(2))
  return pathValue
}

function readJsonFile(path) {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

function normalizeBaseUrl(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url.replace(/\/$/, '')
  return `https://${url.replace(/\/$/, '')}`
}

function ensurePluginConfig(config, pluginConfig) {
  const next = config && typeof config === 'object' ? structuredClone(config) : {}
  if (!next.plugins || typeof next.plugins !== 'object') next.plugins = {}
  if (!Array.isArray(next.plugins.allow)) next.plugins.allow = []
  if (!next.plugins.entries || typeof next.plugins.entries !== 'object') next.plugins.entries = {}

  if (!next.plugins.allow.includes(PLUGIN_ID)) {
    next.plugins.allow.push(PLUGIN_ID)
  }

  const legacyEntry = next.plugins.entries.aamp
  const prevEntry = next.plugins.entries[PLUGIN_ID] ?? legacyEntry
  const mergedConfig = {
    ...(prevEntry?.config && typeof prevEntry.config === 'object' ? prevEntry.config : {}),
    ...pluginConfig,
  }
  if (!pluginConfig.senderPolicies) {
    delete mergedConfig.senderPolicies
  }

  next.plugins.entries[PLUGIN_ID] = {
    enabled: true,
    ...(prevEntry && typeof prevEntry === 'object' ? prevEntry : {}),
    config: mergedConfig,
  }

  if (next.plugins.entries.aamp) {
    delete next.plugins.entries.aamp
  }

  return next
}

function parseDispatchContextRules(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const rules = {}
  for (const part of trimmed.split(';')) {
    const segment = part.trim()
    if (!segment) continue
    const eqIdx = segment.indexOf('=')
    if (eqIdx <= 0) continue
    const key = segment.slice(0, eqIdx).trim().toLowerCase()
    if (!/^[a-z0-9_-]+$/.test(key)) continue
    const values = segment
      .slice(eqIdx + 1)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (values.length) {
      rules[key] = values
    }
  }
  return Object.keys(rules).length ? rules : undefined
}

function isYes(answer, defaultValue = true) {
  const normalized = answer.trim().toLowerCase()
  if (!normalized) return defaultValue
  return ['y', 'yes'].includes(normalized)
}

function packageRootFromEntry(entryPath) {
  let current = dirname(entryPath)
  while (current !== dirname(current)) {
    if (existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  throw new Error(`Could not locate package root for ${entryPath}`)
}

function copyIntoDir(src, dest) {
  cpSync(src, dest, { recursive: true, force: true })
}

function installPluginFiles(credentialsFile = DEFAULT_CREDENTIALS_FILE) {
  const extensionDir = resolveExtensionDir()
  const packageRoot = packageRootFromEntry(fileURLToPath(import.meta.url))
  const packageJson = readJsonFile(join(packageRoot, 'package.json'))
  const credentialsPath = expandHome(credentialsFile)
  const existingCredentials = existsSync(credentialsPath)
    ? readFileSync(credentialsPath)
    : null

  rmSync(extensionDir, { recursive: true, force: true })
  mkdirSync(extensionDir, { recursive: true })

  for (const rel of packageJson.files ?? []) {
    const src = join(packageRoot, rel)
    if (existsSync(src)) {
      copyIntoDir(src, join(extensionDir, rel))
    }
  }

  writeJsonFile(join(extensionDir, 'package.json'), packageJson)

  const dependencyPackages = ['aamp-sdk', 'ws', 'nodemailer']
  const nodeModulesDir = join(extensionDir, 'node_modules')
  mkdirSync(nodeModulesDir, { recursive: true })

  for (const dep of dependencyPackages) {
    const depRoot = join(packageRoot, 'node_modules', dep)
    if (!existsSync(depRoot)) {
      throw new Error(`Missing dependency directory: ${depRoot}`)
    }
    copyIntoDir(depRoot, join(nodeModulesDir, dep))
  }

  if (existingCredentials) {
    mkdirSync(dirname(credentialsPath), { recursive: true })
    writeFileSync(credentialsPath, existingCredentials)
  }

  return extensionDir
}

function restartGateway() {
  const result = spawnSync('openclaw', ['gateway', 'restart'], {
    encoding: 'utf-8',
  })

  if (result.error) {
    return {
      ok: false,
      reason: result.error.message,
    }
  }

  if (result.status !== 0) {
    return {
      ok: false,
      reason: (result.stderr || result.stdout || `exit code ${result.status}`).trim(),
    }
  }

  return {
    ok: true,
    message: (result.stdout || 'Gateway restart requested successfully.').trim(),
  }
}

async function ensureMailboxIdentity({ aampHost, slug, credentialsFile }) {
  const resolvedCreds = expandHome(credentialsFile)
  if (existsSync(resolvedCreds)) {
    return { created: false, email: null, credentialsPath: resolvedCreds }
  }

  const base = normalizeBaseUrl(aampHost)
  const registerRes = await fetch(`${base}/api/nodes/self-register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      slug,
      description: 'OpenClaw AAMP agent node',
    }),
  })

  if (!registerRes.ok) {
    const text = await registerRes.text().catch(() => '')
    throw new Error(`AAMP self-register failed (${registerRes.status}): ${text || registerRes.statusText}`)
  }

  const registerData = await registerRes.json()
  const code = registerData?.registrationCode
  if (!code) {
    throw new Error('AAMP self-register succeeded but no registrationCode was returned')
  }

  const credRes = await fetch(`${base}/api/nodes/credentials?code=${encodeURIComponent(code)}`)
  if (!credRes.ok) {
    const text = await credRes.text().catch(() => '')
    throw new Error(`AAMP credential exchange failed (${credRes.status}): ${text || credRes.statusText}`)
  }

  const credData = await credRes.json()
  const identity = {
    email: credData?.email,
    jmapToken: credData?.jmap?.token,
    smtpPassword: credData?.smtp?.password,
  }

  if (!identity.email || !identity.jmapToken || !identity.smtpPassword) {
    throw new Error('AAMP credential exchange returned an incomplete identity payload')
  }

  writeJsonFile(resolvedCreds, identity)
  return { created: true, email: identity.email, credentialsPath: resolvedCreds }
}

function printHelp() {
  output.write(
    [
      'aamp-openclaw-plugin',
      '',
      'Commands:',
      '  init   Install the OpenClaw plugin and write ~/.openclaw/openclaw.json',
      '  help   Show this help',
      '',
    ].join('\n'),
  )
}

async function runInit() {
  const configPath = resolveOpenClawConfigPath()
  const existing = readJsonFile(configPath)
  const previousEntry = existing?.plugins?.entries?.[PLUGIN_ID] ?? existing?.plugins?.entries?.aamp
  const previousConfig = previousEntry?.config && typeof previousEntry.config === 'object'
    ? previousEntry.config
    : null
  const previousCredentialsFile = previousConfig?.credentialsFile || DEFAULT_CREDENTIALS_FILE
  const previousSlug = previousConfig?.slug || 'openclaw-agent'

  let aampHost = previousConfig?.aampHost || DEFAULT_AAMP_HOST
  let senderPolicies = previousConfig?.senderPolicies
  let slug = previousSlug
  let reuseExistingConfig = Boolean(previousConfig)

  if (input.isTTY) {
    const rl = createInterface({ input, output })
    try {
      output.write('AAMP OpenClaw Plugin Setup\n\n')

      if (previousConfig) {
        output.write(
          [
            'Detected existing plugin config:',
            `  aampHost: ${previousConfig.aampHost ?? DEFAULT_AAMP_HOST}`,
            `  slug: ${previousConfig.slug ?? 'openclaw-agent'}`,
            `  senderPolicies: ${previousConfig.senderPolicies ? JSON.stringify(previousConfig.senderPolicies) : '(allow all)'}`,
            '',
          ].join('\n'),
        )
        const reuseAnswer = await rl.question('Reuse current plugin config? [Y/n]: ')
        reuseExistingConfig = isYes(reuseAnswer, true)
      }

      if (!reuseExistingConfig) {
        const aampHostAnswer = await rl.question(`AAMP Host (${aampHost}): `)
        aampHost = aampHostAnswer.trim() || aampHost

        const senderAnswer = await rl.question(
          'Primary trusted dispatch sender (e.g. platform-bot@meshmail.ai, leave blank to allow all): ',
        )
        const sender = senderAnswer.trim()
        if (sender) {
          const rulesAnswer = await rl.question(
            'Dispatch context rules for that sender (optional, format: project_key=proj1,proj2; user_key=alice): ',
          )
          const dispatchContextRules = parseDispatchContextRules(rulesAnswer)
          senderPolicies = [{
            sender,
            ...(dispatchContextRules ? { dispatchContextRules } : {}),
          }]
        } else {
          senderPolicies = undefined
        }
      }
    } finally {
      rl.close()
    }
  } else {
    if (!reuseExistingConfig) {
      const [hostLine = '', senderLine = '', rulesLine = ''] = readFileSync(0, 'utf-8').split(/\r?\n/)
      aampHost = hostLine.trim() || aampHost
      const sender = senderLine.trim()
      if (sender) {
        const dispatchContextRules = parseDispatchContextRules(rulesLine)
        senderPolicies = [{
          sender,
          ...(dispatchContextRules ? { dispatchContextRules } : {}),
        }]
      } else {
        senderPolicies = undefined
      }
    }
  }

  output.write('\nInstalling OpenClaw plugin files...\n')
  const extensionDir = installPluginFiles(previousCredentialsFile)

  const next = ensurePluginConfig(existing, {
    aampHost,
    slug,
    credentialsFile: DEFAULT_CREDENTIALS_FILE,
    ...(senderPolicies ? { senderPolicies } : {}),
  })

  writeJsonFile(configPath, next)

  const identityResult = await ensureMailboxIdentity({
    aampHost,
    slug,
    credentialsFile: DEFAULT_CREDENTIALS_FILE,
  })

  const restartResult = restartGateway()

  output.write(
    [
      '',
      `Updated ${configPath}`,
      `Installed files to ${extensionDir}`,
      '',
      'Configured plugin entry:',
      `  plugins.entries["${PLUGIN_ID}"]`,
      `  aampHost: ${aampHost}`,
      `  credentialsFile: ${DEFAULT_CREDENTIALS_FILE}`,
      `  senderPolicies: ${senderPolicies ? JSON.stringify(senderPolicies) : '(allow all)'}`,
      identityResult.created
        ? `  mailbox: ${identityResult.email} (registered and saved to ${identityResult.credentialsPath})`
        : `  mailbox: existing credentials reused from ${identityResult.credentialsPath}`,
      '',
      restartResult.ok
        ? `Gateway restart: ${restartResult.message}`
        : `Gateway restart failed: ${restartResult.reason}`,
      restartResult.ok
        ? 'Plugin changes should now be active.'
        : 'Please restart the OpenClaw gateway manually for the plugin changes to take effect.',
      '',
    ].join('\n'),
  )
}

async function main() {
  const command = process.argv[2] || 'help'

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return
  }

  if (command === 'init') {
    await runInit()
    return
  }

  stderr.write(`Unknown command: ${command}\n\n`)
  printHelp()
  process.exitCode = 1
}

main().catch((err) => {
  stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
