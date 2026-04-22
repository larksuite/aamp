import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'

const agentConfigSchema = z.object({
  name: z.string().min(1),
  acpCommand: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/).optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
  cardText: z.string().optional(),
  cardFile: z.string().optional(),
  credentialsFile: z.string().optional(),
  senderWhitelist: z.array(z.string().email()).optional(),
})

const bridgeConfigSchema = z.object({
  aampHost: z.string().url(),
  rejectUnauthorized: z.boolean().default(false),
  agents: z.array(agentConfigSchema).min(1),
})

export type AgentConfig = z.infer<typeof agentConfigSchema>
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>

export function loadConfig(path: string): BridgeConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}. Run 'aamp-acp-bridge init' first.`)
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  return bridgeConfigSchema.parse(raw)
}
