import { describe, expect, it } from 'vitest'
import {
  buildPairingUrl,
  buildPairingWebUrl,
  consumePairingCode,
  createPairedSenderPolicy,
  createPairingCode,
  isPairingUrl,
  matchPairedSenderPolicy,
  pairingUrlToWebUrl,
  parsePairingUrl,
  upsertPairedSenderPolicy,
} from '../src/pairing.js'

describe('pairing URL helpers', () => {
  it('builds and parses a pairing URL', () => {
    const url = buildPairingUrl({
      mailbox: 'Agent@meshmail.ai',
      pairCode: 'abc123',
      dispatchContextRules: {
        Source: ['wechat', ''],
      },
    })

    expect(url).toContain('aamp://connect')
    expect(buildPairingWebUrl(parsePairingUrl(url))).toContain('https://meshmail.ai/pair')
    expect(pairingUrlToWebUrl(url)).toContain('https://meshmail.ai/pair')
    expect(parsePairingUrl(pairingUrlToWebUrl(url))).toEqual({
      mailbox: 'agent@meshmail.ai',
      pairCode: 'abc123',
      dispatchContextRules: {
        source: ['wechat'],
      },
    })
    expect(parsePairingUrl(url)).toEqual({
      mailbox: 'agent@meshmail.ai',
      pairCode: 'abc123',
      dispatchContextRules: {
        source: ['wechat'],
      },
    })
  })

  it('creates expiring pairing codes', () => {
    const pairing = createPairingCode({
      mailbox: 'agent@meshmail.ai',
      pairCode: 'manual-code',
      ttlSeconds: 60,
    })

    expect(pairing.pairCode).toBe('manual-code')
    expect(pairing.connectUrl).toBe('aamp://connect?mailbox=agent%40meshmail.ai&pair_code=manual-code')
    expect(new Date(pairing.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('rejects non-pairing URLs', () => {
    expect(isPairingUrl('https://meshmail.ai')).toBe(false)
    expect(() => parsePairingUrl('aamp://connect?mailbox=agent@meshmail.ai')).toThrow(/pair_code/)
  })

  it('consumes a valid code once and rejects mismatches', () => {
    const now = new Date('2026-05-18T12:00:00.000Z')
    const state = createPairingCode({
      mailbox: 'agent@meshmail.ai',
      pairCode: 'abc123',
      ttlSeconds: 300,
    })
    const fixedState = {
      ...state,
      expiresAt: '2026-05-18T12:05:00.000Z',
    }

    const consumed = consumePairingCode(fixedState, {
      mailbox: 'agent@meshmail.ai',
      pairCode: 'abc123',
      now,
    })

    expect(consumed).toEqual(expect.objectContaining({
      pairCode: '',
      connectUrl: '',
      consumedAt: now.toISOString(),
    }))
    expect(consumePairingCode(consumed!, {
      mailbox: 'agent@meshmail.ai',
      pairCode: 'abc123',
      now,
    })).toBeNull()
    expect(consumePairingCode(fixedState, {
      mailbox: 'agent@meshmail.ai',
      pairCode: 'wrong',
      now,
    })).toBeNull()
  })

  it('creates, upserts, and matches paired sender policies', () => {
    const policy = createPairedSenderPolicy({
      from: 'User@Meshmail.AI',
      dispatchContextRules: {
        project_key: ['proj_1'],
      },
    }, new Date('2026-05-18T12:00:00.000Z'))
    const policies = upsertPairedSenderPolicy([], policy)

    expect(policies).toEqual([{
      sender: 'user@meshmail.ai',
      dispatchContextRules: {
        project_key: ['proj_1'],
      },
      pairedAt: '2026-05-18T12:00:00.000Z',
    }])
    expect(matchPairedSenderPolicy(policies, 'user@meshmail.ai', {
      project_key: 'proj_1',
    })).toEqual({ allowed: true })
    expect(matchPairedSenderPolicy(policies, 'user@meshmail.ai', {
      project_key: 'proj_2',
    })).toEqual({
      allowed: false,
      reason: 'dispatchContext does not match paired sender policy for user@meshmail.ai',
    })
  })
})
