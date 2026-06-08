import { describe, expect, it } from 'vitest';

import { formatStatusMessage } from '../../src/status/StatusMessageFormatter.js';

describe('formatStatusMessage', () => {
  it('renders Session and Codex sections for a fully populated status', () => {
    const message = formatStatusMessage(
      {
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
              cliVersion: '0.135.0',
              reasoningEffort: 'medium',
              summaryMode: 'auto',
              permissions: 'Full Access',
              collaborationMode: 'default',
              tokenUsage: 'total 1320 | input 1200 | cached 800 | output 120 | reasoning 30',
              lastTokenUsage: 'last 220 | input 200 | cached 100 | output 20 | reasoning 5',
              contextWindow: '68% left (1.3K used / 4.1K)',
              primaryLimit: '86% left (resets 2026-06-03T10:30:00.000Z)',
              weeklyLimit: '90% left (resets 2026-06-10T10:30:00.000Z)',
              planType: 'Pro Lite',
              model: 'gpt-5-codex',
              cwd: '/repo',
            },
          },
        },
        runtime: {
          installedCliVersion: '0.136.0',
        },
      },
      { timeZone: 'Asia/Shanghai' },
    );

    expect(message.bodyMarkdown).toContain('## Session');
    expect(message.bodyMarkdown).toContain('## Codex');
    expect(message.bodyMarkdown).toContain('- **Project**: `repo`');
    expect(message.bodyMarkdown).toContain('- **Status**: `running`');
    expect(message.bodyMarkdown).toContain('- **Source**: `live`');
    expect(message.bodyMarkdown).toContain('- **Fetched at**: `2026-06-03 18:00:00 Asia/Shanghai`');
    expect(message.bodyMarkdown).toContain('- **Task**: Implement status integration');
    expect(message.bodyMarkdown).toContain('- **CLI version**: `0.135.0`');
    expect(message.bodyMarkdown).toContain('- **Installed CLI version**: `0.136.0`');
    expect(message.bodyMarkdown).toContain('- **Reasoning**: `medium`');
    expect(message.bodyMarkdown).toContain('- **Summaries**: `auto`');
    expect(message.bodyMarkdown).toContain('- **Permissions**: `Full Access`');
    expect(message.bodyMarkdown).toContain('- **Collaboration mode**: `default`');
    expect(message.bodyMarkdown).toContain('- **Token usage**: `total 1320 | input 1200 | cached 800 | output 120 | reasoning 30`');
    expect(message.bodyMarkdown).toContain('- **Last turn tokens**: `last 220 | input 200 | cached 100 | output 20 | reasoning 5`');
    expect(message.bodyMarkdown).toContain('- **Context window**: `68% left (1.3K used / 4.1K)`');
    expect(message.bodyMarkdown).toContain('- **5h limit**: `86% left (resets 2026-06-03T10:30:00.000Z)`');
    expect(message.bodyMarkdown).toContain('- **Weekly limit**: `90% left (resets 2026-06-10T10:30:00.000Z)`');
    expect(message.bodyMarkdown).toContain('- **Plan type**: `Pro Lite`');
    expect(message.bodyMarkdown).toContain('- **Working directory**: `/repo`');
    expect(message.bodyMarkdown).not.toContain('## Raw');
    expect(message.bodyMarkdown).not.toContain('```text');
    expect(message.fallbackText).toContain('Project: repo');
    expect(message.fallbackText).toContain('Fetched at: 2026-06-03 18:00:00 Asia/Shanghai');
    expect(message.fallbackText).toContain('CLI version: 0.135.0');
    expect(message.fallbackText).toContain('Installed CLI version: 0.136.0');
    expect(message.fallbackText).toContain('5h limit: 86% left (resets 2026-06-03T10:30:00.000Z)');
    expect(message.fallbackText).toContain('Last token usage: last 220 | input 200 | cached 100 | output 20 | reasoning 5');
    expect(message.fallbackText).not.toContain('Raw:');
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
      runtime: {},
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
