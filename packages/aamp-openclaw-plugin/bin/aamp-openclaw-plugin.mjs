#!/usr/bin/env node

import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output, stderr } from 'node:process'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const PLUGIN_ID = 'aamp-openclaw-plugin'
const DEFAULT_AAMP_HOST = 'https://meshmail.ai'
const DEFAULT_CREDENTIALS_FILE = '~/.openclaw/extensions/aamp-openclaw-plugin/.credentials.json'
const CODING_TOOL_ALLOWLIST = [
  'read',
  'write',
  'edit',
  'apply_patch',
  'exec',
  'process',
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_get',
  'sessions_list',
  'sessions_history',
  'sessions_send',
  'sessions_spawn',
  'sessions_yield',
  'subagents',
  'session_status',
  'cron',
  'image',
  'image_generate',
]
const AAMP_PLUGIN_TOOL_ALLOWLIST = [
  'aamp_send_result',
  'aamp_send_help',
  'aamp_pending_tasks',
  'aamp_dispatch_task',
  'aamp_check_protocol',
  'aamp_download_attachment',
]

export function resolveOpenClawHome() {
  return process.env.OPENCLAW_HOME?.trim() || join(homedir(), '.openclaw')
}

export function resolveOpenClawConfigPath() {
  return join(resolveOpenClawHome(), 'openclaw.json')
}

export function resolveExtensionDir() {
  return join(resolveOpenClawHome(), 'extensions', PLUGIN_ID)
}

export function expandHome(pathValue) {
  if (!pathValue) return pathValue
  if (pathValue === '~') return homedir()
  if (pathValue.startsWith('~/')) return join(homedir(), pathValue.slice(2))
  return pathValue
}

function stripJsonComments(text) {
  let result = ''
  let inString = false
  let stringQuote = ''
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    const next = text[i + 1]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === stringQuote) {
        inString = false
        stringQuote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      stringQuote = char
      result += char
      continue
    }

    if (char === '/' && next === '/') {
      i += 2
      while (i < text.length && text[i] !== '\n') i += 1
      if (i < text.length) result += text[i]
      continue
    }

    if (char === '/' && next === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
      i += 1
      continue
    }

    result += char
  }

  return result
}

function stripTrailingCommas(text) {
  let result = ''
  let inString = false
  let stringQuote = ''
  let escaped = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (inString) {
      result += char
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === stringQuote) {
        inString = false
        stringQuote = ''
      }
      continue
    }

    if (char === '"' || char === "'") {
      inString = true
      stringQuote = char
      result += char
      continue
    }

    if (char === ',') {
      let lookahead = i + 1
      while (lookahead < text.length && /\s/.test(text[lookahead])) lookahead += 1
      if (text[lookahead] === '}' || text[lookahead] === ']') {
        continue
      }
    }

    result += char
  }

  return result
}

export function parseJsonConfig(raw, path) {
  const normalized = raw.replace(/^\uFEFF/, '')
  const sanitized = stripTrailingCommas(stripJsonComments(normalized))
  try {
    return JSON.parse(sanitized)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse ${path}: ${reason}`)
  }
}

export function readJsonFile(path) {
  if (!existsSync(path)) return null
  return parseJsonConfig(readFileSync(path, 'utf-8'), path)
}

export function writeJsonFile(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8')
}

export function normalizeBaseUrl(url) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url.replace(/\/$/, '')
  return `https://${url.replace(/\/$/, '')}`
}

export function ensurePluginConfig(config, pluginConfig, options = {}) {
  const next = config && typeof config === 'object' ? structuredClone(config) : {}
  if (!next.plugins || typeof next.plugins !== 'object') next.plugins = {}
  if (!Array.isArray(next.plugins.allow)) next.plugins.allow = []
  if (!next.plugins.entries || typeof next.plugins.entries !== 'object') next.plugins.entries = {}
  if (!next.channels || typeof next.channels !== 'object') next.channels = {}

  if (!next.plugins.allow.includes(PLUGIN_ID)) {
    next.plugins.allow.push(PLUGIN_ID)
  }

  const legacyEntry = next.plugins.entries.aamp
  const prevEntry = next.plugins.entries[PLUGIN_ID] ?? legacyEntry
  next.plugins.entries[PLUGIN_ID] = {
    enabled: true,
    ...(prevEntry && typeof prevEntry === 'object' ? prevEntry : {}),
  }

  if (next.plugins.entries.aamp) {
    delete next.plugins.entries.aamp
  }

  const previousChannelConfig =
    next.channels.aamp && typeof next.channels.aamp === 'object' ? next.channels.aamp : {}
  const mergedChannelConfig = {
    ...previousChannelConfig,
    ...pluginConfig,
    enabled: true,
  }
  if (!pluginConfig.senderPolicies) {
    delete mergedChannelConfig.senderPolicies
  }
  next.channels.aamp = mergedChannelConfig

  next.tools = ensureAampToolAllowlist(next.tools, options)

  return next
}

function ensurePluginInstallRecord(config, installRecord) {
  const next = config && typeof config === 'object' ? structuredClone(config) : {}
  if (!next.plugins || typeof next.plugins !== 'object') next.plugins = {}
  if (!next.plugins.installs || typeof next.plugins.installs !== 'object') next.plugins.installs = {}

  next.plugins.installs[PLUGIN_ID] = {
    ...(next.plugins.installs[PLUGIN_ID] && typeof next.plugins.installs[PLUGIN_ID] === 'object'
      ? next.plugins.installs[PLUGIN_ID]
      : {}),
    ...installRecord,
  }

  if (next.plugins.installs.aamp) {
    delete next.plugins.installs.aamp
  }

  return next
}

export function ensureAampToolAllowlist(toolsConfig, options = {}) {
  const next = toolsConfig && typeof toolsConfig === 'object' ? structuredClone(toolsConfig) : {}
  const existingAllow = Array.isArray(next.allow) ? next.allow.filter((value) => typeof value === 'string' && value.trim()) : []
  const includeCodingBaseline = options.includeCodingBaseline === true

  const mergedAllow = [
    ...existingAllow,
    ...(includeCodingBaseline ? CODING_TOOL_ALLOWLIST : []),
    ...AAMP_PLUGIN_TOOL_ALLOWLIST,
  ]

  next.allow = Array.from(new Set(mergedAllow))

  return next
}

export function planToolPolicyUpdate(toolsConfig, options = {}) {
  const current = toolsConfig && typeof toolsConfig === 'object' ? structuredClone(toolsConfig) : {}
  const existingAllow = Array.isArray(current.allow) ? current.allow.filter((value) => typeof value === 'string' && value.trim()) : []
  const includeCodingBaseline = options.includeCodingBaseline === true
  const missingAampTools = AAMP_PLUGIN_TOOL_ALLOWLIST.filter((tool) => !existingAllow.includes(tool))
  const currentProfile = typeof current.profile === 'string' ? current.profile : undefined
  const missingCodingTools = includeCodingBaseline
    ? CODING_TOOL_ALLOWLIST.filter((tool) => !existingAllow.includes(tool))
    : []

  return {
    current,
    missingAampTools,
    missingCodingTools,
    needsAnyChange: missingAampTools.length > 0 || missingCodingTools.length > 0,
    needsNonPluginChange: missingCodingTools.length > 0,
    currentProfile,
    next: ensureAampToolAllowlist(current, { includeCodingBaseline }),
  }
}

function currentToolPolicySummary(plan) {
  const lines = []
  if (plan.currentProfile) {
    lines.push(`  current tools.profile: ${plan.currentProfile}`)
  } else {
    lines.push(`  current tools.profile: (none)`)
  }
  lines.push(`  current tools.allow count: ${Array.isArray(plan.current.allow) ? plan.current.allow.length : 0}`)
  if (plan.missingAampTools.length > 0) {
    lines.push(`  missing AAMP tools: ${plan.missingAampTools.join(', ')}`)
  }
  if (plan.needsNonPluginChange) {
    lines.push(`  additional core tools to add: ${plan.missingCodingTools.join(', ')}`)
  }
  return lines.join('\n')
}

export function parseDispatchContextRules(raw) {
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

function ensureBuiltArtifacts(packageRoot) {
  const entryFile = join(packageRoot, 'dist', 'index.js')
  if (existsSync(entryFile)) return

  const result = spawnSync('npm', ['run', 'build'], {
    cwd: packageRoot,
    encoding: 'utf-8',
  })

  if (result.error) {
    throw new Error(`Failed to build plugin artifacts: ${result.error.message}`)
  }

  if (result.status !== 0) {
    throw new Error(
      `Failed to build plugin artifacts: ${(result.stderr || result.stdout || `exit code ${result.status}`).trim()}`,
    )
  }

  if (!existsSync(entryFile)) {
    throw new Error(`Plugin build completed but ${entryFile} is still missing`)
  }
}

export function installPluginFiles(credentialsFile = DEFAULT_CREDENTIALS_FILE) {
  const extensionDir = resolveExtensionDir()
  const packageRoot = packageRootFromEntry(fileURLToPath(import.meta.url))
  ensureBuiltArtifacts(packageRoot)
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

  const dependencyPackages = ['ws', 'nodemailer']
  const nodeModulesDir = join(extensionDir, 'node_modules')
  mkdirSync(nodeModulesDir, { recursive: true })

  const requireFromPlugin = createRequire(import.meta.url)

  for (const dep of dependencyPackages) {
    let depRoot
    try {
      depRoot = dirname(requireFromPlugin.resolve(`${dep}/package.json`))
    } catch {
      depRoot = join(packageRoot, 'node_modules', dep)
    }
    if (!existsSync(depRoot)) {
      throw new Error(`Missing dependency directory: ${depRoot}`)
    }
    copyIntoDir(depRoot, join(nodeModulesDir, dep))
  }

  if (existingCredentials) {
    mkdirSync(dirname(credentialsPath), { recursive: true })
    writeFileSync(credentialsPath, existingCredentials)
  }

  return { extensionDir, packageJson, packageRoot }
}

export function restartGateway() {
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

export async function ensureMailboxIdentity({ aampHost, slug, credentialsFile }) {
  const resolvedCreds = expandHome(credentialsFile)
  if (existsSync(resolvedCreds)) {
    const cachedIdentity = readJsonFile(resolvedCreds)
    return {
      created: false,
      email: cachedIdentity?.email ?? null,
      credentialsPath: resolvedCreds,
    }
  }

  const base = normalizeBaseUrl(aampHost)
  const discoveryRes = await fetch(`${base}/.well-known/aamp`)
  if (!discoveryRes.ok) {
    const text = await discoveryRes.text().catch(() => '')
    throw new Error(`AAMP discovery failed (${discoveryRes.status}): ${text || discoveryRes.statusText}`)
  }
  const discovery = await discoveryRes.json()
  const apiUrl = discovery?.api?.url
  if (!apiUrl) {
    throw new Error('AAMP discovery did not return api.url')
  }
  const apiBase = new URL(apiUrl, `${base}/`).toString()

  const registerRes = await fetch(`${apiBase}?action=aamp.mailbox.register`, {
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

  const credRes = await fetch(`${apiBase}?action=aamp.mailbox.credentials&code=${encodeURIComponent(code)}`)
  if (!credRes.ok) {
    const text = await credRes.text().catch(() => '')
    throw new Error(`AAMP credential exchange failed (${credRes.status}): ${text || credRes.statusText}`)
  }

  const credData = await credRes.json()
  const identity = {
    email: credData?.email,
    mailboxToken: credData?.mailbox?.token ?? credData?.jmap?.token,
    smtpPassword: credData?.smtp?.password,
  }

  if (!identity.email || !identity.mailboxToken || !identity.smtpPassword) {
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

export async function runInit() {
  const configPath = resolveOpenClawConfigPath()
  const existing = readJsonFile(configPath)
  const previousEntry = existing?.plugins?.entries?.[PLUGIN_ID] ?? existing?.plugins?.entries?.aamp
  const previousConfig =
    existing?.channels?.aamp && typeof existing.channels.aamp === 'object'
      ? existing.channels.aamp
      : previousEntry?.config && typeof previousEntry.config === 'object'
        ? previousEntry.config
        : null
  const previousCredentialsFile = previousConfig?.credentialsFile || DEFAULT_CREDENTIALS_FILE
  const previousSlug = previousConfig?.slug || 'openclaw-agent'

  let aampHost = previousConfig?.aampHost || DEFAULT_AAMP_HOST
  let senderPolicies = previousConfig?.senderPolicies
  let slug = previousSlug
  let reuseExistingConfig = Boolean(previousConfig)
  let includeCodingBaseline = false

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
          'Primary trusted dispatch sender (e.g. meegle-bot@meshmail.ai, leave blank to allow all): ',
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

      const codingPromptPlan = planToolPolicyUpdate(existing?.tools, { includeCodingBaseline: true })
      const shouldOfferCodingBaseline =
        codingPromptPlan.missingCodingTools.length > 0 &&
        !Array.isArray(existing?.tools?.allow) &&
        !(typeof existing?.tools?.profile === 'string' && existing.tools.profile.trim())

      if (shouldOfferCodingBaseline) {
        output.write(
          [
            '',
            'Optional tool policy upgrade:',
            '  Default init only adds the AAMP plugin tools needed for mailbox-style task receive/reply.',
            '  If this agent also needs file/shell/web coding workflows, you can additionally add',
            '  the coding baseline tool set now.',
            currentToolPolicySummary(codingPromptPlan),
            '',
          ].join('\n'),
        )
        const toolAnswer = await rl.question('Also add coding baseline tools? [y/N]: ')
        includeCodingBaseline = isYes(toolAnswer, false)
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
  const { extensionDir, packageJson, packageRoot } = installPluginFiles(previousCredentialsFile)

  const toolPolicyPlan = planToolPolicyUpdate(existing?.tools, { includeCodingBaseline })
  let next = ensurePluginConfig(existing, {
    aampHost,
    slug,
    credentialsFile: DEFAULT_CREDENTIALS_FILE,
    ...(senderPolicies ? { senderPolicies } : {}),
  }, {
    includeCodingBaseline,
  })

  const now = new Date().toISOString()
  next = ensurePluginInstallRecord(next, {
    source: 'npm',
    spec: packageJson?.name || PLUGIN_ID,
    sourcePath: packageRoot,
    installPath: extensionDir,
    version: packageJson?.version || '0.0.0',
    resolvedName: packageJson?.name || PLUGIN_ID,
    resolvedVersion: packageJson?.version || '0.0.0',
    resolvedSpec: `${packageJson?.name || PLUGIN_ID}@${packageJson?.version || '0.0.0'}`,
    installedAt: now,
    resolvedAt: now,
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
      `  plugins.installs["${PLUGIN_ID}"]`,
      `  channels.aamp.enabled: ${next.channels?.aamp?.enabled === true ? 'true' : 'false'}`,
      `  aampHost: ${aampHost}`,
      `  credentialsFile: ${DEFAULT_CREDENTIALS_FILE}`,
      `  senderPolicies: ${senderPolicies ? JSON.stringify(senderPolicies) : '(allow all)'}`,
      `  tools.allow: ${JSON.stringify(next.tools?.allow ?? [])}`,
      `  codingBaselineAdded: ${toolPolicyPlan.missingCodingTools.length > 0 && includeCodingBaseline ? 'yes' : 'no'}`,
      identityResult.created
        ? `  mailbox: ${identityResult.email} (registered and saved to ${identityResult.credentialsPath})`
        : identityResult.email
          ? `  mailbox: ${identityResult.email} (existing credentials reused from ${identityResult.credentialsPath})`
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

export async function main() {
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

export function shouldRunAsCli(argv1 = process.argv[1]) {
  if (!argv1) return false

  const entryPath = fileURLToPath(import.meta.url)
  try {
    return realpathSync(argv1) === realpathSync(entryPath)
  } catch {
    return resolve(argv1) === entryPath
  }
}

if (shouldRunAsCli()) {
  main().catch((err) => {
    stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
