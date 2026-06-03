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
    expect(message.bodyMarkdown).toContain('```text');
    expect(message.fallbackText).toContain('Project: repo');
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
