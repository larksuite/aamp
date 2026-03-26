/**
 * Unit tests for AAMP header parser
 * Acceptance criterion: 100% parse coverage for task.dispatch, task.result, task.help
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
        from: 'workflow-bot@meshmail.ai',
        to: 'codereviewer@meshmail.ai',
        messageId: '<msg-123@meshmail.ai>',
        subject: '[AAMP Task] Review PR #456',
        headers: {
          'X-AAMP-Intent': 'task.dispatch',
          'X-AAMP-TaskId': 'task-uuid-1234',
          'X-AAMP-Timeout': '300',
          'X-AAMP-ContextLinks':
            'https://tracker.example.com/issues/1,https://git.example.com/pr/456',
        },
      })

      expect(result).not.toBeNull()
      expect(result!.intent).toBe('task.dispatch')
      if (result!.intent !== 'task.dispatch') return

      expect(result.taskId).toBe('task-uuid-1234')
      expect(result.title).toBe('Review PR #456')
      expect(result.timeoutSecs).toBe(300)
      expect(result.contextLinks).toEqual([
        'https://tracker.example.com/issues/1',
        'https://git.example.com/pr/456',
      ])
      expect(result.from).toBe('workflow-bot@meshmail.ai')
      expect(result.to).toBe('codereviewer@meshmail.ai')
      expect(result.messageId).toBe('<msg-123@meshmail.ai>')
    })

    it('handles headers with angle brackets in from/to', () => {
      const result = parseAampHeaders({
        from: '<workflow-bot@meshmail.ai>',
        to: '<agent@meshmail.ai>',
        messageId: '<msg@host>',
        subject: '[AAMP Task] Do something',
        headers: {
          'X-AAMP-Intent': 'task.dispatch',
          'X-AAMP-TaskId': 'task-abc',
          'X-AAMP-Timeout': '600',
          'X-AAMP-ContextLinks': '',
        },
      })

      expect(result!.from).toBe('workflow-bot@meshmail.ai')
      expect(result!.to).toBe('agent@meshmail.ai')
    })

    it('handles case-insensitive headers', () => {
      const result = parseAampHeaders({
        from: 'workflow-bot@meshmail.ai',
        to: 'agent@meshmail.ai',
        messageId: 'msg',
        subject: '[AAMP Task] Test',
        headers: {
          'x-aamp-intent': 'task.dispatch',
          'x-aamp-taskid': 'task-lowercase',
          'x-aamp-timeout': '120',
          'x-aamp-contextlinks': '',
        },
      })

      expect(result).not.toBeNull()
      expect(result!.taskId).toBe('task-lowercase')
    })

    it('strips [AAMP Task] prefix from subject for title', () => {
      const result = parseAampHeaders({
        from: 'workflow-bot@meshmail.ai',
        to: 'agent@meshmail.ai',
        messageId: 'msg',
        subject: '[AAMP Task] My Task Title',
        headers: {
          'x-aamp-intent': 'task.dispatch',
          'x-aamp-taskid': 'task-1',
          'x-aamp-timeout': '300',
          'x-aamp-contextlinks': '',
        },
      })

      expect(result!.intent === 'task.dispatch' ? result!.title : '').toBe('My Task Title')
    })

    it('handles empty contextLinks gracefully', () => {
      const result = parseAampHeaders({
        from: 'workflow-bot@meshmail.ai',
        to: 'agent@meshmail.ai',
        messageId: 'msg',
        subject: 'Task',
        headers: {
          'x-aamp-intent': 'task.dispatch',
          'x-aamp-taskid': 'task-1',
          'x-aamp-timeout': '300',
          'x-aamp-contextlinks': '',
        },
      })

      if (result?.intent !== 'task.dispatch') throw new Error('wrong intent')
      expect(result.contextLinks).toEqual([])
    })

    it('defaults timeout to 300 if not a valid number', () => {
      const result = parseAampHeaders({
        from: 'a@b.com',
        to: 'c@d.com',
        messageId: 'x',
        subject: 'Task',
        headers: {
          'x-aamp-intent': 'task.dispatch',
          'x-aamp-taskid': 'task-1',
          'x-aamp-timeout': 'not-a-number',
          'x-aamp-contextlinks': '',
        },
      })

      if (result?.intent !== 'task.dispatch') throw new Error('wrong intent')
      expect(result.timeoutSecs).toBe(300)
    })
  })

  describe('task.result', () => {
    it('parses a completed task.result', () => {
      const result = parseAampHeaders({
        from: 'agent@meshmail.ai',
        to: 'workflow-bot@meshmail.ai',
        messageId: '<result-msg>',
        subject: '[AAMP Result] Task task-1 — completed',
        headers: {
          'x-aamp-intent': 'task.result',
          'x-aamp-taskid': 'task-1',
          'x-aamp-status': 'completed',
          'x-aamp-output': 'Analysis done. Found 3 issues.',
        },
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
        from: 'agent@meshmail.ai',
        to: 'workflow-bot@meshmail.ai',
        messageId: '<result-msg>',
        subject: '[AAMP Result] Task task-2 — rejected',
        headers: {
          'x-aamp-intent': 'task.result',
          'x-aamp-taskid': 'task-2',
          'x-aamp-status': 'rejected',
          'x-aamp-output': '',
          'x-aamp-errormsg': 'Insufficient permissions to access the repository',
        },
      })

      if (result?.intent !== 'task.result') throw new Error('wrong intent')
      expect(result.status).toBe('rejected')
      expect(result.errorMsg).toBe('Insufficient permissions to access the repository')
    })

    it('defaults status to completed if not present', () => {
      const result = parseAampHeaders({
        from: 'agent@meshmail.ai',
        to: 'workflow-bot@meshmail.ai',
        messageId: '<result-msg>',
        subject: 'Result',
        headers: {
          'x-aamp-intent': 'task.result',
          'x-aamp-taskid': 'task-3',
          'x-aamp-output': 'Done',
        },
      })

      if (result?.intent !== 'task.result') throw new Error('wrong intent')
      expect(result.status).toBe('completed')
    })
  })

  describe('task.help', () => {
    it('parses a task.help request', () => {
      const result = parseAampHeaders({
        from: 'agent@meshmail.ai',
        to: 'workflow-bot@meshmail.ai',
        messageId: '<help-msg>',
        subject: '[AAMP Help] Task task-1 needs assistance',
        headers: {
          'x-aamp-intent': 'task.help',
          'x-aamp-taskid': 'task-1',
          'x-aamp-question': 'Should I use option A or option B?',
          'x-aamp-blockedreason': 'Design decision required before proceeding',
          'x-aamp-suggestedoptions': 'Option A: Simple approach|Option B: Complex but faster|Defer decision',
        },
      })

      expect(result).not.toBeNull()
      expect(result!.intent).toBe('task.help')
      if (result!.intent !== 'task.help') return

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
          'x-aamp-intent': 'task.help',
          'x-aamp-taskid': 'task-1',
          'x-aamp-question': 'What should I do?',
          'x-aamp-blockedreason': 'Unclear spec',
          'x-aamp-suggestedoptions': '',
        },
      })

      if (result?.intent !== 'task.help') throw new Error('wrong intent')
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
  it('builds correct dispatch headers (no callbackUrl)', () => {
    const headers = buildDispatchHeaders({
      taskId: 'task-123',
      timeoutSecs: 300,
      contextLinks: ['https://a.com', 'https://b.com'],
    })

    expect(headers['X-AAMP-Intent']).toBe('task.dispatch')
    expect(headers['X-AAMP-TaskId']).toBe('task-123')
    expect(headers['X-AAMP-Timeout']).toBe('300')
    expect(headers['X-AAMP-ContextLinks']).toBe('https://a.com,https://b.com')
    expect(headers['X-AAMP-CallbackUrl']).toBeUndefined()
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
    expect(headers['X-AAMP-Output']).toBe('Task done!')
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
    expect(headers['X-AAMP-ErrorMsg']).toBe('Access denied')
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

    expect(headers['X-AAMP-Intent']).toBe('task.help')
    expect(headers['X-AAMP-TaskId']).toBe('task-123')
    expect(headers['X-AAMP-Question']).toBe('Which option?')
    expect(headers['X-AAMP-BlockedReason']).toBe('Decision needed')
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
      timeoutSecs: 180,
      contextLinks: ['https://link1.com', 'https://link2.com'],
    })

    const parsed = parseAampHeaders({
      from: 'workflow-bot@meshmail.ai',
      to: 'agent@meshmail.ai',
      messageId: 'msg-rt-1',
      subject: '[AAMP Task] Round trip task',
      headers: built as Record<string, string>,
    })

    if (parsed?.intent !== 'task.dispatch') throw new Error('expected task.dispatch')
    expect(parsed.taskId).toBe('task-rt-1')
    expect(parsed.timeoutSecs).toBe(180)
    expect(parsed.contextLinks).toEqual(['https://link1.com', 'https://link2.com'])
  })

  it('round-trips task.result', () => {
    const built = buildResultHeaders({ taskId: 'task-rt-2', status: 'completed', output: 'Done' })

    const parsed = parseAampHeaders({
      from: 'agent@meshmail.ai',
      to: 'workflow-bot@meshmail.ai',
      messageId: 'msg-rt-2',
      subject: '[AAMP Result] ...',
      headers: built as Record<string, string>,
    })

    if (parsed?.intent !== 'task.result') throw new Error('expected task.result')
    expect(parsed.taskId).toBe('task-rt-2')
    expect(parsed.status).toBe('completed')
    expect(parsed.output).toBe('Done')
  })

  it('round-trips task.help', () => {
    const built = buildHelpHeaders({
      taskId: 'task-rt-3',
      question: 'Which DB?',
      blockedReason: 'Schema unclear',
      suggestedOptions: ['PostgreSQL', 'MySQL'],
    })

    const parsed = parseAampHeaders({
      from: 'agent@meshmail.ai',
      to: 'workflow-bot@meshmail.ai',
      messageId: 'msg-rt-3',
      subject: '[AAMP Help] ...',
      headers: built as Record<string, string>,
    })

    if (parsed?.intent !== 'task.help') throw new Error('expected task.help')
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
