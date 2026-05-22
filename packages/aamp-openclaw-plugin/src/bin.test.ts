import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('openclaw plugin installer helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    const home = mkdtempSync(path.join(os.tmpdir(), 'aamp-openclaw-cli-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os')
      return { ...actual, homedir: () => home }
    })
  })

  it('creates mailbox credentials through discovered endpoints', async () => {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input)
      if (url.endsWith('/.well-known/aamp')) {
        return new Response(JSON.stringify({ api: { url: '/api/aamp' } }))
      }
      if (url.includes('aamp.mailbox.register')) {
        return new Response(JSON.stringify({ registrationCode: 'reg-1' }))
      }
      if (url.includes('aamp.mailbox.credentials')) {
        return new Response(JSON.stringify({
          email: 'agent@meshmail.ai',
          mailbox: { token: 'mailbox-token' },
          smtp: { password: 'smtp-1' },
        }))
      }
      return new Response(JSON.stringify({ error: `unexpected url: ${url}` }), { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const { ensureMailboxIdentity } = await import('../bin/aamp-openclaw-plugin.mjs')
    const credentialsPath = path.join(process.env.HOME!, '.openclaw', 'extensions', 'aamp-openclaw-plugin', '.credentials.json')
    const result = await ensureMailboxIdentity({
      aampHost: 'https://meshmail.ai',
      slug: 'openclaw-agent',
      credentialsFile: credentialsPath,
    })

    expect(result).toEqual({
      created: true,
      email: 'agent@meshmail.ai',
      credentialsPath,
    })
    const saved = JSON.parse(readFileSync(credentialsPath, 'utf8'))
    expect(saved).toMatchObject({
      email: 'agent@meshmail.ai',
      mailboxToken: 'mailbox-token',
      smtpPassword: 'smtp-1',
    })
  })

  it('merges channel config and AAMP tools into OpenClaw config', async () => {
    const { ensurePluginConfig } = await import('../bin/aamp-openclaw-plugin.mjs')
    const next = ensurePluginConfig({}, {
      aampHost: 'https://meshmail.ai',
      slug: 'openclaw-agent',
      credentialsFile: '~/.openclaw/extensions/aamp-openclaw-plugin/.credentials.json',
      senderPolicies: [{ sender: 'dispatcher@meshmail.ai' }],
    })

    expect(next.plugins.allow).toContain('aamp-openclaw-plugin')
    expect(next.channels.aamp).toMatchObject({
      enabled: true,
      aampHost: 'https://meshmail.ai',
      slug: 'openclaw-agent',
    })
    expect(next.tools.allow).toContain('aamp_send_result')
    expect(next.tools.allow).toContain('aamp_directory_search')
    expect(next.tools.allow).toContain('aamp_pairing_code')
    expect(next.tools.allow).toContain('aamp_cancel_task')
    expect(next.tools.allow).toContain('aamp_dispatch_task')
  })

  it('parses and compares OpenClaw host versions', async () => {
    const {
      MIN_OPENCLAW_VERSION,
      checkOpenClawVersion,
      compareOpenClawVersions,
      parseOpenClawVersion,
    } = await import('../bin/aamp-openclaw-plugin.mjs')

    expect(MIN_OPENCLAW_VERSION).toBe('2026.3.22')
    expect(parseOpenClawVersion('OpenClaw 2026.4.27 (cbc2ba0)')).toBe('2026.4.27')
    expect(parseOpenClawVersion('openclaw 2026.3.22-beta.1')).toBe('2026.3.22-beta.1')
    expect(compareOpenClawVersions('2026.4.1', '2026.3.22')).toBeGreaterThan(0)
    expect(compareOpenClawVersions('2026.3.22', '2026.3.22')).toBe(0)
    expect(compareOpenClawVersions('2026.3.22-beta.1', '2026.3.22')).toBeLessThan(0)
    expect(checkOpenClawVersion('2026.3.21')).toMatchObject({
      ok: false,
      currentVersion: '2026.3.21',
      minimumVersion: '2026.3.22',
      range: '>=2026.3.22',
    })
    expect(checkOpenClawVersion('2026.3.22').ok).toBe(true)
  })

  it('rejects installs on unsupported OpenClaw host versions before setup work starts', async () => {
    const { assertOpenClawVersionSupported } = await import('../bin/aamp-openclaw-plugin.mjs')

    expect(() => assertOpenClawVersionSupported('2026.3.21')).toThrow(/requires OpenClaw >=2026\.3\.22/)
    expect(assertOpenClawVersionSupported('2026.3.22')).toMatchObject({
      ok: true,
      currentVersion: '2026.3.22',
      minimumVersion: '2026.3.22',
    })
  })

  it('treats symlinked bin execution as CLI entrypoint', async () => {
    const { shouldRunAsCli } = await import('../bin/aamp-openclaw-plugin.mjs')
    const binPath = path.resolve(process.cwd(), 'bin', 'aamp-openclaw-plugin.mjs')
    const linkPath = path.join(process.env.HOME!, 'aamp-openclaw-plugin')
    symlinkSync(binPath, linkPath)

    expect(shouldRunAsCli(linkPath)).toBe(true)
  })

  it('prints help when invoked through a symlinked bin path', () => {
    const binPath = path.resolve(process.cwd(), 'bin', 'aamp-openclaw-plugin.mjs')
    const linkPath = path.join(process.env.HOME!, 'aamp-openclaw-plugin')
    symlinkSync(binPath, linkPath)

    const stdout = execFileSync(linkPath, ['help'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
    })

    expect(stdout).toContain('aamp-openclaw-plugin')
    expect(stdout).toContain('Commands:')
    expect(stdout).toContain('init')
  })
})
