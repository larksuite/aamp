import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getNodeRootDir, getNodeStateRootDir } from './storage.js'

export interface NodeMailboxConfig {
  email: string
  smtpPassword: string
  baseUrl?: string
  smtpHost?: string
  smtpPort?: number
  rejectUnauthorized?: boolean
}

export type JsonSchemaType = 'object' | 'string' | 'number' | 'boolean' | 'array'

export interface SimpleJsonSchema {
  type: JsonSchemaType
  description?: string
  required?: string[]
  additionalProperties?: boolean
  properties?: Record<string, SimpleJsonSchema>
  items?: SimpleJsonSchema
  enum?: Array<string | number | boolean>
}

export interface RegisteredAttachmentSlot {
  required?: boolean
  contentTypes?: string[]
  maxBytes?: number
}

export interface RegisteredCommand {
  name: string
  description?: string
  exec: string
  argsTemplate: string[]
  workingDirectory: string
  environment?: Record<string, string>
  pathArgs?: string[]
  argSchema?: SimpleJsonSchema
  attachments?: Record<string, RegisteredAttachmentSlot>
  timeoutMs?: number
  maxStdoutBytes?: number
  maxStderrBytes?: number
  enabled?: boolean
}

export interface SenderPolicyConfig {
  defaultAction: 'allow' | 'deny'
  allowFrom: string[]
  allowCommands: string[]
  requireContext: Record<string, string>
}

export interface NodeConfig {
  version: 1
  mailbox: NodeMailboxConfig
  commands: RegisteredCommand[]
  senderPolicy: SenderPolicyConfig
}

export const DEFAULT_NODE_NAME = 'default'

const DEFAULT_CONFIG: Omit<NodeConfig, 'mailbox'> = {
  version: 1,
  commands: [],
  senderPolicy: {
    defaultAction: 'deny',
    allowFrom: [],
    allowCommands: [],
    requireContext: {},
  },
}

export function getNodeConfigPath(nodeName = DEFAULT_NODE_NAME): string {
  return path.join(getNodeRootDir(), `${nodeName}.json`)
}

export function getNodeCommandSpecsDir(nodeName = DEFAULT_NODE_NAME): string {
  return path.join(getNodeRootDir(), `${nodeName}.commands`)
}

export function getNodeStateDir(nodeName = DEFAULT_NODE_NAME): string {
  return path.join(getNodeStateRootDir(), nodeName)
}

function normalizeNodeConfig(raw: NodeConfig): NodeConfig {
  return {
    version: 1,
    mailbox: raw.mailbox,
    commands: Array.isArray(raw.commands)
      ? raw.commands.map((command) => ({
          ...command,
          environment: command.environment && typeof command.environment === 'object'
            ? Object.fromEntries(
                Object.entries(command.environment)
                  .filter(([key, value]) => key && typeof value === 'string'),
              )
            : undefined,
        }))
      : [],
    senderPolicy: {
      defaultAction: raw.senderPolicy?.defaultAction === 'allow' ? 'allow' : 'deny',
      allowFrom: Array.isArray(raw.senderPolicy?.allowFrom) ? raw.senderPolicy.allowFrom : [],
      allowCommands: Array.isArray(raw.senderPolicy?.allowCommands) ? raw.senderPolicy.allowCommands : [],
      requireContext: raw.senderPolicy?.requireContext ?? {},
    },
  }
}

export async function loadNodeConfig(nodeName = DEFAULT_NODE_NAME): Promise<NodeConfig> {
  const file = getNodeConfigPath(nodeName)
  if (!existsSync(file)) {
    throw new Error(`Node "${nodeName}" not found. Run "aamp-cli node init${nodeName === DEFAULT_NODE_NAME ? '' : ` --node ${nodeName}`}" first.`)
  }
  const raw = await readFile(file, 'utf8')
  return normalizeNodeConfig(JSON.parse(raw) as NodeConfig)
}

export async function saveNodeConfig(nodeName: string, config: NodeConfig): Promise<string> {
  const file = getNodeConfigPath(nodeName)
  await mkdir(path.dirname(file), { recursive: true })
  const normalized = normalizeNodeConfig(config)
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return file
}

export function createDefaultNodeConfig(mailbox: NodeMailboxConfig): NodeConfig {
  return {
    ...DEFAULT_CONFIG,
    mailbox,
  }
}
