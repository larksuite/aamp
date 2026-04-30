import { afterEach, describe, expect, it, vi } from 'vitest'

const sessionPayload = {
  capabilities: {
    'urn:ietf:params:jmap:core': {},
    'urn:ietf:params:jmap:mail': {},
  },
  accounts: {
    account1: {
      name: 'Primary',
      isPrimary: true,
      accountCapabilities: {},
    },
  },
  primaryAccounts: {
    'urn:ietf:params:jmap:mail': 'account1',
  },
  username: 'agent@meshmail.ai',
  apiUrl: 'https://meshmail.ai/jmap/',
  downloadUrl: 'https://meshmail.ai/download/{accountId}/{blobId}/{name}',
  uploadUrl: 'https://meshmail.ai/upload/{accountId}/',
  eventSourceUrl: 'https://meshmail.ai/eventsource/',
  state: 'state-1',
}

describe('JmapPushClient session fetch', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('retries transient JMAP discovery failures before succeeding', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }))
      .mockResolvedValueOnce(new Response('still warming up', { status: 503, statusText: 'Service Unavailable' }))
      .mockResolvedValueOnce(new Response(JSON.stringify(sessionPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const { JmapPushClient } = await import('../src/jmap-push.js')
    const client = new JmapPushClient({
      email: 'agent@meshmail.ai',
      password: 'secret',
      jmapUrl: 'https://meshmail.ai',
    })

    const pending = (client as any).fetchSession()
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toMatchObject({
      username: 'agent@meshmail.ai',
      apiUrl: 'https://meshmail.ai/jmap/',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails fast on non-retryable JMAP discovery responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('unauthorized', { status: 401, statusText: 'Unauthorized' }))
    vi.stubGlobal('fetch', fetchMock)

    const { JmapPushClient } = await import('../src/jmap-push.js')
    const client = new JmapPushClient({
      email: 'agent@meshmail.ai',
      password: 'secret',
      jmapUrl: 'https://meshmail.ai',
    })

    await expect((client as any).fetchSession()).rejects.toThrow('Failed to fetch JMAP session: 401 Unauthorized')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('JmapPushClient blob download', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('retries transient fetch errors before succeeding', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const { JmapPushClient } = await import('../src/jmap-push.js')
    const client = new JmapPushClient({
      email: 'agent@meshmail.ai',
      password: 'secret',
      jmapUrl: 'https://meshmail.ai',
    })
    ;(client as any).session = sessionPayload

    const pending = client.downloadBlob('blob-123', 'payload.zip')
    await vi.runAllTimersAsync()

    await expect(pending).resolves.toEqual(Buffer.from([1, 2, 3]))
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('rewrites session download URLs to the configured origin without leaking internal ports', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(Uint8Array.from([9]), {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const { JmapPushClient } = await import('../src/jmap-push.js')
    const client = new JmapPushClient({
      email: 'agent@meshmail.ai',
      password: 'secret',
      jmapUrl: 'https://meshmail.ai',
    })
    ;(client as any).session = {
      ...sessionPayload,
      downloadUrl: 'http://meshmail.ai:8080/jmap/download/{accountId}/{blobId}/{name}?accept={type}',
    }

    await expect(client.downloadBlob('blob-456', 'payload.zip')).resolves.toEqual(Buffer.from([9]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://meshmail.ai/jmap/download/account1/blob-456/payload.zip?accept=application/octet-stream',
    )
  })
})
