import { describe, expect, it } from 'vitest';
import { formatObservationTail } from '../../src/output/ObservationTailFormatter.js';

describe('formatObservationTail', () => {
  it('renders commentary-first progress summaries', () => {
    const reply = formatObservationTail({
      availability: { kind: 'ready' },
      codexSessionId: 'session-1',
      status: 'running',
      latestCommentary: '我先补 observation parser，再接 /tail。',
      recentToolEvents: [
        { kind: 'tool_call', toolName: 'exec_command', summary: 'exec_command: rg -n "tail" src', at: '2026-06-02T08:10:00.000Z' },
      ],
    });

    expect(reply).toContain('Status: running');
    expect(reply).toContain('我先补 observation parser，再接 /tail。');
    expect(reply).toContain('exec_command: rg -n "tail" src');
  });

  it('renders final answers for completed snapshots', () => {
    const reply = formatObservationTail({
      availability: { kind: 'ready' },
      codexSessionId: 'session-2',
      status: 'completed',
      finalAnswer: '最终方案：保留 PTY，用户侧改读 observation。',
      completedAt: '2026-06-02T08:12:00.000Z',
      recentToolEvents: [],
    });

    expect(reply).toContain('Status: completed');
    expect(reply).toContain('最终方案：保留 PTY，用户侧改读 observation。');
    expect(reply).toContain('Completed: 2026-06-02T08:12:00.000Z');
  });

  it('truncates long tool activity blocks', () => {
    const reply = formatObservationTail({
      availability: { kind: 'ready' },
      codexSessionId: 'session-3',
      status: 'running',
      recentToolEvents: Array.from({ length: 6 }, (_, index) => ({
        kind: 'tool_call' as const,
        toolName: 'exec_command',
        summary: `exec_command: command-${index + 1}`,
        at: `2026-06-02T08:13:0${index}.000Z`,
      })),
    });

    expect(reply).not.toContain('exec_command: command-3');
    expect(reply).toContain('exec_command: command-4');
    expect(reply).toContain('exec_command: command-5');
    expect(reply).toContain('exec_command: command-6');
    expect(reply).not.toContain('exec_command: command-1');
  });

  it('renders a guidance message for unavailable snapshots', () => {
    const reply = formatObservationTail({
      availability: { kind: 'not_found' },
      codexSessionId: 'session-4',
      status: 'unknown',
      recentToolEvents: [],
    });

    expect(reply).toBe('No structured Codex observation yet. Use /rawtail 80 for raw terminal logs.');
  });

  it('surfaces parse errors with an operator-facing message', () => {
    const reply = formatObservationTail({
      availability: { kind: 'parse_error', reason: 'Unexpected token' },
      codexSessionId: 'session-5',
      status: 'unknown',
      recentToolEvents: [],
    });

    expect(reply).toContain('Structured Codex observation failed to parse.');
    expect(reply).toContain('Unexpected token');
    expect(reply).toContain('/rawtail 80');
  });
});
