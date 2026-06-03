import { describe, expect, it } from 'vitest';

import { formatStatusMessage } from '../../src/status/StatusMessageFormatter.js';

describe('formatStatusMessage', () => {
  it('renders Session, Codex, and Raw sections for a fully populated status', () => {
    const message = formatStatusMessage({
      session: {
        projectId: 'repo',
        sessionId: 'sess_123',
        status: 'running',
        summary: 'recent work summary',
        pendingApprovals: ['ap_1'],
      },
      codex: {
        kind: 'available',
        status: {
          source: 'live',
          fetchedAt: '2026-06-03T10:00:00.000Z',
          rawText: 'Status: running\nTask: Implement status integration',
          summary: {
            statusLine: 'running',
            currentTask: 'Implement status integration',
            tokenUsage: 'total 1320 | input 1200 | cached 800 | output 120 | reasoning 30',
            lastTokenUsage: 'last 220 | input 200 | cached 100 | output 20 | reasoning 5',
            contextWindow: '4096 total | 2776 remaining',
            rateLimits: 'primary 14% / 300m | secondary 10% / 10080m | plan prolite',
            resetTimes: 'primary 2026-06-03T10:30:00.000Z | secondary 2026-06-10T10:30:00.000Z',
            model: 'gpt-5-codex',
          },
        },
      },
    });

    expect(message.bodyMarkdown).toContain('## Session');
    expect(message.bodyMarkdown).toContain('## Codex');
    expect(message.bodyMarkdown).toContain('## Raw');
    expect(message.bodyMarkdown).toContain('- **Project**: `repo`');
    expect(message.bodyMarkdown).toContain('- **Status**: `running`');
    expect(message.bodyMarkdown).toContain('- **Source**: `live`');
    expect(message.bodyMarkdown).toContain('- **Task**: Implement status integration');
    expect(message.bodyMarkdown).toContain('- **Token usage**: `total 1320 | input 1200 | cached 800 | output 120 | reasoning 30`');
    expect(message.bodyMarkdown).toContain('- **Last turn tokens**: `last 220 | input 200 | cached 100 | output 20 | reasoning 5`');
    expect(message.bodyMarkdown).toContain('- **Context window**: `4096 total | 2776 remaining`');
    expect(message.bodyMarkdown).toContain('- **Rate limits**: `primary 14% / 300m | secondary 10% / 10080m | plan prolite`');
    expect(message.bodyMarkdown).toContain('- **Resets**: `primary 2026-06-03T10:30:00.000Z | secondary 2026-06-10T10:30:00.000Z`');
    expect(message.bodyMarkdown).toContain('```text');
    expect(message.fallbackText).toContain('Project: repo');
    expect(message.fallbackText).toContain('Last token usage: last 220 | input 200 | cached 100 | output 20 | reasoning 5');
  });

  it('omits empty optional local fields and shows Codex unavailable', () => {
    const message = formatStatusMessage({
      session: {
        projectId: 'repo',
        sessionId: 'sess_123',
        status: 'running',
        summary: undefined,
        pendingApprovals: [],
      },
      codex: { kind: 'unavailable' },
    });

    expect(message.bodyMarkdown).toContain('## Session');
    expect(message.bodyMarkdown).not.toContain('Summary');
    expect(message.bodyMarkdown).not.toContain('Pending approvals');
    expect(message.bodyMarkdown).toContain('## Codex\nUnavailable');
    expect(message.bodyMarkdown).not.toContain('## Raw');
    expect(message.fallbackText).not.toContain('Summary:');
    expect(message.fallbackText).not.toContain('Pending approvals:');
  });
});
