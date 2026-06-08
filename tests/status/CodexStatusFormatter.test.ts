import { describe, expect, it } from 'vitest';
import { formatCodexStatusSection } from '../../src/status/CodexStatusFormatter.js';

describe('formatCodexStatusSection', () => {
  it('renders structured summary fields without the raw appendix', () => {
    const reply = formatCodexStatusSection(
      {
        kind: 'available',
        status: {
          source: 'live',
          fetchedAt: '2026-06-03T08:00:00.000Z',
          rawText: 'Status: running\nTask: Implement status integration',
          summary: {
            statusLine: 'running',
            currentTask: 'Implement status integration',
          },
        },
      },
      { timeZone: 'Asia/Shanghai' },
    );

    expect(reply).toContain('Codex status');
    expect(reply).toContain('Source: live');
    expect(reply).toContain('Fetched at: 2026-06-03 16:00:00 Asia/Shanghai');
    expect(reply).toContain('Status line: running');
    expect(reply).toContain('Current task: Implement status integration');
    expect(reply).not.toContain('Codex raw status:');
    expect(reply).not.toContain('Status: running\nTask: Implement status integration');
  });

  it('renders unavailable when nothing can be shown', () => {
    expect(formatCodexStatusSection({ kind: 'unavailable' })).toContain('Codex status: unavailable');
  });
});
