import { z } from 'zod'
import { readFileSync, existsSync } from 'node:fs'

const senderPolicySchema = z.object({
  sender: z.string().email(),
  dispatchContextRules: z.record(z.array(z.string().min(1))).optional(),
})

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
  senderPolicies: z.array(senderPolicySchema).optional(),
  taskDispatchConcurrency: z.number().int().positive().optional(),
})

const bridgeConfigSchema = z.object({
  aampHost: z.string().url(),
  rejectUnauthorized: z.boolean().default(false),
  agents: z.array(agentConfigSchema).min(1),
})

export type SenderPolicy = z.infer<typeof senderPolicySchema>
export type AgentConfig = z.infer<typeof agentConfigSchema>
export type BridgeConfig = z.infer<typeof bridgeConfigSchema>

function normalizeSenderPolicies(
  senderPolicies: SenderPolicy[] | undefined,
  senderWhitelist: string[] | undefined,
): SenderPolicy[] | undefined {
  const sourcePolicies: SenderPolicy[] | undefined = senderPolicies?.length
    ? senderPolicies
    : senderWhitelist?.length
      ? senderWhitelist.map((sender): SenderPolicy => ({ sender }))
      : undefined

  if (!sourcePolicies?.length) return undefined

  const normalized = sourcePolicies
    .map((policy) => {
      let dispatchContextRules: Record<string, string[]> | undefined
      if (policy.dispatchContextRules) {
        dispatchContextRules = Object.fromEntries(
          Object.entries(policy.dispatchContextRules as Record<string, string[]>)
            .map(([key, values]) => [
              key.trim().toLowerCase(),
              values.map((value) => value.trim()).filter(Boolean),
            ])
            .filter(([key, values]) => Boolean(key) && values.length > 0),
        )
      }

      return {
        sender: policy.sender.trim().toLowerCase(),
        ...(dispatchContextRules && Object.keys(dispatchContextRules).length > 0
          ? { dispatchContextRules }
          : {}),
      }
    })
    .filter((policy) => Boolean(policy.sender))

  return normalized.length > 0 ? normalized : undefined
}

function normalizeAgentConfig(agent: AgentConfig): AgentConfig {
  return {
    ...agent,
    senderPolicies: normalizeSenderPolicies(agent.senderPolicies, agent.senderWhitelist),
  }
}

export function loadConfig(path: string): BridgeConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}. Run 'aamp-acp-bridge init' first.`)
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  const parsed = bridgeConfigSchema.parse(raw)
  return {
    ...parsed,
    agents: parsed.agents.map(normalizeAgentConfig),
  }
}
