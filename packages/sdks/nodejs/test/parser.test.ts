/**
 * Unit tests for AAMP header parser
 * Acceptance criterion: 100% parse coverage for task.dispatch, task.result, task.help_needed
 */

import { describe, it, expect } from 'vitest'
import {
  parseAampHeaders,
  buildDispatchHeaders,
  buildResultHeaders,
  buildHelpHeaders,
  normalizeHeaders,
} from '../src/parser.js'

// =====================================================
// parseAampHeaders
// =====================================================

describe('parseAampHeaders', () => {
  describe('task.dispatch', () => {
    it('parses a valid task.dispatch email', () => {
      const result = parseAampHeaders({
        from: 'meego-bot@aamp.example.com',
        to: 'codereviewer@aamp.example.com',
        messageId: '<msg-123@aamp.example.com>',
        subject: '[AAMP Task] Review PR #456',
        headers: {
          'X-AAMP-Intent': 'task.dispatch',
          'X-AAMP-TaskId': 'task-uuid-1234',
          'X-AAMP-Expires-At': '2026-04-07T12:00:00.000Z',
          'X-AAMP-ContextLinks':
            'https://meego.example.com/issues/1,https://git.example.com/pr/456',
        },
      })

      expect(result).not.toBeNull()
      expect(result!.intent).toBe('task.dispatch')
      if (result!.intent !== 'task.dispatch') return

      expect(result.taskId).toBe('task-uuid-1234')
      expect(result.title).toBe('Review PR #456')
      expect(result.expiresAt).toBe('2026-04-07T12:00:00.000Z')
      expect(result.contextLinks).toEqual([
        'https://meego.example.com/issues/1',
        'https://git.example.com/pr/456',
      ])
      expect(result.from).toBe('meego-bot@aamp.example.com')
      expect(result.to).toBe('codereviewer@aamp.example.com')
      expect(result.messageId).toBe('<msg-123@aamp.example.com>')
    })

    it('handles headers with angle brackets in from/to', () => {
      const result = parseAampHeaders({
        from: '<meego-bot@aamp.example.com>',
        to: '<agent@aamp.example.com>',
        messageId: '<msg@host>',
        subject: '[AAMP Task] Do something',
        headers: {
          'X-AAMP-Intent': 'task.dispatch',
          'X-AAMP-TaskId': 'task-abc',
          'X-AAMP-Expires-At': '2026-04-07T12:00:00.000Z',
          'X-AAMP-ContextLinks': '',
        },
      })

      expect(result!.from).toBe('meego-bot@aamp.example.com')
      expect(result!.to).toBe('agent@aamp.example.com')
    })

    it('handles case-insensitive headers', () => {
      const result = parseAampHeaders({
        from: 'meego-bot@aamp.example.com',
        to: 'agent@aamp.example.com',
        messageId: 'msg',
        subject: '[AAMP Task] Test',
        headers: {
          'x-aamp-intent': 'task.dispatch',
          'x-aamp-taskid': 'task-lowercase',
          'x-aamp-expires-at': '2026-04-07T12:00:00.000Z',
          'x-aamp-contextlinks': '',
        },
      })

      expect(result).not.toBeNull()
      expect(result!.taskId).toBe('task-lowercase')
    })

    it('strips [AAMP Task] prefix from subject for title', () => {
      const result = parseAampHeaders({
        from: 'meego-bot@aamp.example.com',
        to: 'agent@aamp.example.com',
        messageId: 'msg',
        subject: '[AAMP Task] My Task Title',
        headers: {
          'x-aamp-intent': 'task.dispatch',
          'x-aamp-taskid': 'task-1',
          'x-aamp-expires-at': '2026-04-07T12:00:00.000Z',
          'x-aamp-contextlinks': '',
        },
      })

      expect(result!.intent === 'task.dispatch' ? result!.title : '').toBe('My Task Title')
    })

    it('handles empty contextLinks gracefully', () => {
      const result = parseAampHeaders({
        from: 'meego-bot@aamp.example.com',
        to: 'agent@aamp.example.com',
        messageId: 'msg',
        subject: 'Task',
        headers: {
          'x-aamp-intent': 'task.dispatch',
          'x-aamp-taskid': 'task-1',
          'x-aamp-expires-at': '2026-04-07T12:00:00.000Z',
          'x-aamp-contextlinks': '',
        },
      })

      if (result?.intent !== 'task.dispatch') throw new Error('wrong intent')
      expect(result.contextLinks).toEqual([])
    })

    it('omits expiresAt when the header is absent', () => {
      const result = parseAampHeaders({
        from: 'a@b.com',
        to: 'c@d.com',
        messageId: 'x',
        subject: 'Task',
        headers: {
          'x-aamp-intent': 'task.dispatch',
          'x-aamp-taskid': 'task-1',
          'x-aamp-contextlinks': '',
        },
      })

      if (result?.intent !== 'task.dispatch') throw new Error('wrong intent')
      expect(result.expiresAt).toBeUndefined()
    })
  })

  describe('task.result', () => {
    it('parses a completed task.result', () => {
      const result = parseAampHeaders({
        from: 'agent@aamp.example.com',
        to: 'meego-bot@aamp.example.com',
        messageId: '<result-msg>',
        subject: '[AAMP Result] Task task-1 — completed',
        headers: {
          'x-aamp-intent': 'task.result',
          'x-aamp-taskid': 'task-1',
          'x-aamp-status': 'completed',
        },
        bodyText: ['AAMP Task Result', '', 'Task ID: task-1', 'Status: completed', '', 'Output:', 'Analysis done. Found 3 issues.'].join('\n'),
      })

      expect(result).not.toBeNull()
      expect(result!.intent).toBe('task.result')
      if (result!.intent !== 'task.result') return

      expect(result.taskId).toBe('task-1')
      expect(result.status).toBe('completed')
      expect(result.output).toBe('Analysis done. Found 3 issues.')
      expect(result.errorMsg).toBeUndefined()
    })

    it('parses a rejected task.result with error message', () => {
      const result = parseAampHeaders({
        from: 'agent@aamp.example.com',
        to: 'meego-bot@aamp.example.com',
        messageId: '<result-msg>',
        subject: '[AAMP Result] Task task-2 — rejected',
        headers: {
          'x-aamp-intent': 'task.result',
          'x-aamp-taskid': 'task-2',
          'x-aamp-status': 'rejected',
        },
        bodyText: ['AAMP Task Result', '', 'Task ID: task-2', 'Status: rejected', '', 'Output:', '', 'Error: Insufficient permissions to access the repository'].join('\n'),
      })

      if (result?.intent !== 'task.result') throw new Error('wrong intent')
      expect(result.status).toBe('rejected')
      expect(result.errorMsg).toBe('Insufficient permissions to access the repository')
    })

    it('defaults status to completed if not present', () => {
      const result = parseAampHeaders({
        from: 'agent@aamp.example.com',
        to: 'meego-bot@aamp.example.com',
        messageId: '<result-msg>',
        subject: 'Result',
        headers: {
          'x-aamp-intent': 'task.result',
          'x-aamp-taskid': 'task-3',
        },
        bodyText: 'Done',
      })

      if (result?.intent !== 'task.result') throw new Error('wrong intent')
      expect(result.status).toBe('completed')
    })
  })

  describe('task.help_needed', () => {
    it('parses a task.help_needed request', () => {
      const result = parseAampHeaders({
        from: 'agent@aamp.example.com',
        to: 'meego-bot@aamp.example.com',
        messageId: '<help-msg>',
        subject: '[AAMP Help] Task task-1 needs assistance',
        headers: {
          'x-aamp-intent': 'task.help_needed',
          'x-aamp-taskid': 'task-1',
          'x-aamp-suggestedoptions': 'Option A: Simple approach|Option B: Complex but faster|Defer decision',
        },
        bodyText: [
          'AAMP Task Help Request',
          '',
          'Task ID: task-1',
          '',
          'Question: Should I use option A or option B?',
          '',
          'Blocked reason: Design decision required before proceeding',
          '',
          'Suggested options:',
          '  1. Option A: Simple approach',
          '  2. Option B: Complex but faster',
          '  3. Defer decision',
        ].join('\n'),
      })

      expect(result).not.toBeNull()
      expect(result!.intent).toBe('task.help_needed')
      if (result!.intent !== 'task.help_needed') return

      expect(result.taskId).toBe('task-1')
      expect(result.question).toBe('Should I use option A or option B?')
      expect(result.blockedReason).toBe('Design decision required before proceeding')
      expect(result.suggestedOptions).toEqual([
        'Option A: Simple approach',
        'Option B: Complex but faster',
        'Defer decision',
      ])
    })

    it('handles empty suggestedOptions', () => {
      const result = parseAampHeaders({
        from: 'a@b.com',
        to: 'c@d.com',
        messageId: 'x',
        subject: 'Help',
        headers: {
          'x-aamp-intent': 'task.help_needed',
          'x-aamp-taskid': 'task-1',
        },
        bodyText: ['AAMP Task Help Request', '', 'Task ID: task-1', '', 'Question: What should I do?', '', 'Blocked reason: Unclear spec'].join('\n'),
      })

      if (result?.intent !== 'task.help_needed') throw new Error('wrong intent')
      expect(result.suggestedOptions).toEqual([])
    })
  })

  describe('non-AAMP emails', () => {
    it('returns null for emails without X-AAMP-Intent', () => {
      const result = parseAampHeaders({
        from: 'alice@example.com',
        to: 'bob@example.com',
        messageId: '<normal-email>',
        subject: 'Hello Bob',
        headers: { Subject: 'Hello Bob', From: 'alice@example.com' },
      })

      expect(result).toBeNull()
    })

    it('returns null when taskId is missing', () => {
      const result = parseAampHeaders({
        from: 'a@b.com',
        to: 'c@d.com',
        messageId: 'x',
        subject: 'test',
        headers: { 'x-aamp-intent': 'task.dispatch' },
      })

      expect(result).toBeNull()
    })

    it('returns null for unknown intent', () => {
      const result = parseAampHeaders({
        from: 'a@b.com',
        to: 'c@d.com',
        messageId: 'x',
        subject: 'test',
        headers: { 'x-aamp-intent': 'task.unknown', 'x-aamp-taskid': 'task-1' },
      })

      expect(result).toBeNull()
    })
  })
})

// =====================================================
// Header builders
// =====================================================

describe('buildDispatchHeaders', () => {
  it('builds correct dispatch headers', () => {
    const headers = buildDispatchHeaders({
      taskId: 'task-123',
      expiresAt: '2026-04-07T12:00:00.000Z',
      contextLinks: ['https://a.com', 'https://b.com'],
    })

    expect(headers['X-AAMP-Intent']).toBe('task.dispatch')
    expect(headers['X-AAMP-TaskId']).toBe('task-123')
    expect(headers['X-AAMP-Expires-At']).toBe('2026-04-07T12:00:00.000Z')
    expect(headers['X-AAMP-ContextLinks']).toBe('https://a.com,https://b.com')
  })
})

describe('buildResultHeaders', () => {
  it('builds correct result headers for completed', () => {
    const headers = buildResultHeaders({
      taskId: 'task-123',
      status: 'completed',
      output: 'Task done!',
    })

    expect(headers['X-AAMP-Intent']).toBe('task.result')
    expect(headers['X-AAMP-TaskId']).toBe('task-123')
    expect(headers['X-AAMP-Status']).toBe('completed')
    expect(headers['X-AAMP-Output']).toBeUndefined()
    expect(headers['X-AAMP-ErrorMsg']).toBeUndefined()
  })

  it('includes error message for rejected', () => {
    const headers = buildResultHeaders({
      taskId: 'task-123',
      status: 'rejected',
      output: '',
      errorMsg: 'Access denied',
    })

    expect(headers['X-AAMP-Status']).toBe('rejected')
    expect(headers['X-AAMP-ErrorMsg']).toBeUndefined()
  })
})

describe('buildHelpHeaders', () => {
  it('builds correct help headers', () => {
    const headers = buildHelpHeaders({
      taskId: 'task-123',
      question: 'Which option?',
      blockedReason: 'Decision needed',
      suggestedOptions: ['Option A', 'Option B'],
    })

    expect(headers['X-AAMP-Intent']).toBe('task.help_needed')
    expect(headers['X-AAMP-TaskId']).toBe('task-123')
    expect(headers['X-AAMP-SuggestedOptions']).toBe('Option A|Option B')
  })
})

// =====================================================
// Round-trip tests: build → parse
// =====================================================

describe('round-trip: build headers then parse them', () => {
  it('round-trips task.dispatch', () => {
    const built = buildDispatchHeaders({
      taskId: 'task-rt-1',
      expiresAt: '2026-04-07T12:00:00.000Z',
      contextLinks: ['https://link1.com', 'https://link2.com'],
    })

    const parsed = parseAampHeaders({
      from: 'meego-bot@aamp.example.com',
      to: 'agent@aamp.example.com',
      messageId: 'msg-rt-1',
      subject: '[AAMP Task] Round trip task',
      headers: built as Record<string, string>,
    })

    if (parsed?.intent !== 'task.dispatch') throw new Error('expected task.dispatch')
    expect(parsed.taskId).toBe('task-rt-1')
    expect(parsed.expiresAt).toBe('2026-04-07T12:00:00.000Z')
    expect(parsed.contextLinks).toEqual(['https://link1.com', 'https://link2.com'])
  })

  it('round-trips task.result', () => {
    const built = buildResultHeaders({ taskId: 'task-rt-2', status: 'completed', output: 'Done' })

    const parsed = parseAampHeaders({
      from: 'agent@aamp.example.com',
      to: 'meego-bot@aamp.example.com',
      messageId: 'msg-rt-2',
      subject: '[AAMP Result] ...',
      headers: built as Record<string, string>,
      bodyText: ['AAMP Task Result', '', 'Task ID: task-rt-2', 'Status: completed', '', 'Output:', 'Done'].join('\n'),
    })

    if (parsed?.intent !== 'task.result') throw new Error('expected task.result')
    expect(parsed.taskId).toBe('task-rt-2')
    expect(parsed.status).toBe('completed')
    expect(parsed.output).toBe('Done')
  })

  it('round-trips task.help_needed', () => {
    const built = buildHelpHeaders({
      taskId: 'task-rt-3',
      question: 'Which DB?',
      blockedReason: 'Schema unclear',
      suggestedOptions: ['PostgreSQL', 'MySQL'],
    })

    const parsed = parseAampHeaders({
      from: 'agent@aamp.example.com',
      to: 'meego-bot@aamp.example.com',
      messageId: 'msg-rt-3',
      subject: '[AAMP Help] ...',
      headers: built as Record<string, string>,
      bodyText: [
        'AAMP Task Help Request',
        '',
        'Task ID: task-rt-3',
        '',
        'Question: Which DB?',
        '',
        'Blocked reason: Schema unclear',
        '',
        'Suggested options:',
        '  1. PostgreSQL',
        '  2. MySQL',
      ].join('\n'),
    })

    if (parsed?.intent !== 'task.help_needed') throw new Error('expected task.help_needed')
    expect(parsed.taskId).toBe('task-rt-3')
    expect(parsed.question).toBe('Which DB?')
    expect(parsed.blockedReason).toBe('Schema unclear')
    expect(parsed.suggestedOptions).toEqual(['PostgreSQL', 'MySQL'])
  })
})

// =====================================================
// normalizeHeaders
// =====================================================

describe('normalizeHeaders', () => {
  it('lowercases all keys', () => {
    const result = normalizeHeaders({
      'Content-Type': 'text/plain',
      'X-AAMP-Intent': 'task.dispatch',
    })

    expect(result['content-type']).toBe('text/plain')
    expect(result['x-aamp-intent']).toBe('task.dispatch')
  })

  it('picks first value from string arrays', () => {
    const result = normalizeHeaders({ 'X-Header': ['first', 'second'] })
    expect(result['x-header']).toBe('first')
  })
})
