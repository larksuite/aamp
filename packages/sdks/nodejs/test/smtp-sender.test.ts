import { beforeEach, describe, expect, it, vi } from 'vitest'

const fakeTransport = {
  sendMail: vi.fn(),
  verify: vi.fn().mockResolvedValue(true),
  close: vi.fn(),
}

describe('SmtpSender', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    fakeTransport.sendMail.mockReset()
    fakeTransport.verify.mockResolvedValue(true)
    vi.doMock('nodemailer', () => ({
      createTransport: vi.fn(() => fakeTransport),
    }))
  })

  it('uses HTTP fallback for same-domain dispatches and preserves attachments', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ api: { url: '/api/aamp' } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'http-msg-1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accounts: { acc1: { name: 'agent', isPersonal: true } },
        primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc1' },
        uploadUrl: 'http://internal:8080/jmap/upload/{accountId}/',
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        methodResponses: [
          ['Mailbox/get', { list: [{ id: 'sent-box', role: 'sent' }] }, 'mb1'],
        ],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        accountId: 'acc1',
        blobId: 'blob-raw-message',
        type: 'message/rfc822',
        size: Buffer.from('raw sent message').byteLength,
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        methodResponses: [
          ['Email/import', { imported: { sent1: { id: 'created-1' } } }, 'import1'],
        ],
      })))
    vi.stubGlobal('fetch', fetchMock)
    fakeTransport.sendMail.mockResolvedValueOnce({
      messageId: 'raw-msg-1',
      message: Buffer.from('raw sent message'),
    })

    const { SmtpSender } = await import('../src/smtp-sender.js')
    const sender = SmtpSender.fromMailboxIdentity({
      email: 'agent@meshmail.ai',
      password: 'smtp-1',
      baseUrl: 'https://meshmail.ai',
    })

    const result = await sender.sendTask({
      to: 'dispatcher@meshmail.ai',
      title: 'Review docs',
      bodyText: 'Please check the latest protocol.',
      attachments: [{
        filename: 'context.txt',
        contentType: 'text/plain',
        content: Buffer.from('hello world'),
      }],
      dispatchContext: { project_key: 'proj-1' },
    })

    expect(result.messageId).toBe('http-msg-1')
    expect(fakeTransport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'agent@meshmail.ai',
      to: 'dispatcher@meshmail.ai',
      subject: '[AAMP Task] Review docs',
      messageId: 'http-msg-1',
      attachments: [expect.objectContaining({
        filename: 'context.txt',
        contentType: 'text/plain',
        content: Buffer.from('hello world'),
      })],
    }))
    const payload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    expect(payload.to).toBe('dispatcher@meshmail.ai')
    expect(payload.attachments).toEqual([{
      filename: 'context.txt',
      contentType: 'text/plain',
      content: Buffer.from('hello world').toString('base64'),
    }])
    expect(payload.aampHeaders['X-AAMP-Dispatch-Context']).toContain('project_key=proj-1')
    expect(String(fetchMock.mock.calls[2][0])).toBe('https://meshmail.ai/.well-known/jmap')
    expect(String(fetchMock.mock.calls[3][0])).toBe('https://meshmail.ai/jmap/')
    expect(String(fetchMock.mock.calls[4][0])).toBe('https://meshmail.ai/jmap/upload/acc1/')
    expect(fetchMock.mock.calls[4][1]?.headers).toEqual(expect.objectContaining({
      'Content-Type': 'message/rfc822',
    }))
    expect(String(fetchMock.mock.calls[5][0])).toBe('https://meshmail.ai/jmap/')
    const sentPayload = JSON.parse(String(fetchMock.mock.calls[5][1]?.body))
    expect(sentPayload.methodCalls[0][0]).toBe('Email/import')
    expect(sentPayload.methodCalls[0][1].emails.sent1).toEqual({
      blobId: 'blob-raw-message',
      mailboxIds: { 'sent-box': true },
      keywords: { '$seen': true },
    })
  })

  it('uses SMTP for external recipients', async () => {
    const { SmtpSender } = await import('../src/smtp-sender.js')
    const sender = new SmtpSender({
      host: 'meshmail.ai',
      port: 587,
      user: 'agent@meshmail.ai',
      password: 'smtp-1',
    })

    fakeTransport.sendMail.mockResolvedValueOnce({ messageId: 'smtp-msg-1' })
    const result = await sender.sendTask({
      to: 'reviewer@example.com',
      title: 'Review docs',
      bodyText: 'Please check the latest protocol.',
    })

    expect(result.messageId).toBe('smtp-msg-1')
    expect(fakeTransport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'reviewer@example.com',
      subject: '[AAMP Task] Review docs',
      headers: expect.objectContaining({
        'X-AAMP-Intent': 'task.dispatch',
      }),
    }))
  })

  it('builds card.query and card.response messages with the correct AAMP headers', async () => {
    const { SmtpSender } = await import('../src/smtp-sender.js')
    const sender = new SmtpSender({
      host: 'meshmail.ai',
      port: 587,
      user: 'agent@meshmail.ai',
      password: 'smtp-1',
    })

    fakeTransport.sendMail
      .mockResolvedValueOnce({ messageId: 'card-query-msg-1' })
      .mockResolvedValueOnce({ messageId: 'card-response-msg-1' })

    const queryResult = await sender.sendCardQuery({
      to: 'reviewer@example.com',
      taskId: 'card-5',
      bodyText: 'Please send your agent card.',
    })
    await sender.sendCardResponse({
      to: 'reviewer@example.com',
      taskId: 'card-5',
      summary: 'Reviews code and summarizes incidents',
      bodyText: 'Full card body',
    })

    expect(queryResult).toEqual({ taskId: 'card-5', messageId: 'card-query-msg-1' })
    expect(fakeTransport.sendMail).toHaveBeenNthCalledWith(1, expect.objectContaining({
      to: 'reviewer@example.com',
      subject: '[AAMP Card Query] card-5',
      text: 'Please send your agent card.',
      headers: expect.objectContaining({
        'X-AAMP-Intent': 'card.query',
        'X-AAMP-TaskId': 'card-5',
      }),
    }))
    expect(fakeTransport.sendMail).toHaveBeenNthCalledWith(2, expect.objectContaining({
      to: 'reviewer@example.com',
      subject: '[AAMP Card] Reviews code and summarizes incidents',
      text: 'Full card body',
      headers: expect.objectContaining({
        'X-AAMP-Intent': 'card.response',
        'X-AAMP-TaskId': 'card-5',
        'X-AAMP-Card-Summary': 'Reviews code and summarizes incidents',
      }),
    }))
  })

  it('builds pair.respond messages with status and failure reason', async () => {
    const { SmtpSender } = await import('../src/smtp-sender.js')
    const sender = new SmtpSender({
      host: 'meshmail.ai',
      port: 587,
      user: 'agent@meshmail.ai',
      password: 'smtp-1',
    })

    fakeTransport.sendMail.mockResolvedValueOnce({ messageId: 'pair-response-msg-1' })
    await sender.sendPairRespond({
      to: 'app@example.com',
      taskId: 'pair-5',
      success: false,
      reason: 'invalid or expired pair code',
      inReplyTo: '<pair-request>',
    })

    expect(fakeTransport.sendMail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'app@example.com',
      subject: '[AAMP Pair] rejected',
      inReplyTo: '<pair-request>',
      references: '<pair-request>',
      headers: expect.objectContaining({
        'X-AAMP-Intent': 'pair.respond',
        'X-AAMP-TaskId': 'pair-5',
        'X-AAMP-Status': 'rejected',
        'X-AAMP-ErrorMsg': 'invalid or expired pair code',
      }),
    }))
  })

  it('retries transient HTTP fallback failures before giving up on pair.respond', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ api: { url: '/api/aamp' } })))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 'pair-response-msg-2' })))
    vi.stubGlobal('fetch', fetchMock)

    const { SmtpSender } = await import('../src/smtp-sender.js')
    const sender = new SmtpSender({
      host: 'meshmail.ai',
      port: 587,
      user: 'agent@meshmail.ai',
      password: 'smtp-1',
      httpBaseUrl: 'https://meshmail.ai',
      authToken: Buffer.from('agent@meshmail.ai:smtp-1').toString('base64'),
      forceHttpSend: true,
      persistSentCopy: false,
    })

    await sender.sendPairRespond({
      to: 'app@meshmail.ai',
      taskId: 'pair-6',
      success: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[2][0])).toBe('https://meshmail.ai/api/aamp?action=aamp.mailbox.send')
  })
})
