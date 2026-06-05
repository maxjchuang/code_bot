import { describe, expect, it } from 'vitest';
import { renderCurrentScreenCard } from '../../src/feishu/CurrentScreenCard.js';
import type { TerminalSnapshot } from '../../src/output/TerminalScreenBuffer.js';

const config = {
  cols: 40,
  rows: 6,
  scrollback: 20,
  replayMaxBytes: 4096,
  cardMaxRows: 6,
  cardMaxLineChars: 20,
  maxStyledSegmentsPerLine: 2,
};

function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    cols: 40,
    capturedAt: '2026-06-05T10:00:00.000Z',
    source: 'live',
    truncated: false,
    notes: [],
    rows: [
      { text: '╭──── Codex ────╮', spans: [] },
      { text: '⚠ warning here', spans: [{ text: '⚠ warning here', color: 'yellow' }] },
      { text: '› 只读查看当前目录', spans: [] },
    ],
    ...overrides,
  };
}

describe('renderCurrentScreenCard', () => {
  it('renders a TerminalSnapshot as a Feishu card with text fallback', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot(),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    expect(rendered.preferred.kind).toBe('card');
    expect(rendered.fallback).toEqual(expect.objectContaining({ kind: 'text' }));
    expect(JSON.stringify(rendered.preferred)).toContain('Codex Current');
    expect(JSON.stringify(rendered.preferred)).toContain('⚠ warning here');
    expect(rendered.fallback.kind === 'text' ? rendered.fallback.text : '').toContain('› 只读查看当前目录');
  });

  it('includes title, session/project/status/source/capture metadata, and terminal row text', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot(),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    const preferredJson = JSON.stringify(rendered.preferred);
    expect(preferredJson).toContain('Codex Current');
    expect(preferredJson).toContain('sess_1');
    expect(preferredJson).toContain('repo');
    expect(preferredJson).toContain('running');
    expect(preferredJson).toContain('live');
    expect(preferredJson).toContain('2026-06-05T10:00:00.000Z');
    expect(preferredJson).toContain('╭──── Codex ────╮');
    expect(preferredJson).toContain('› 只读查看当前目录');
  });

  it('truncates long rows and records a footer note', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot({ rows: [{ text: 'this line is much longer than the card limit', spans: [] }] }),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    expect(JSON.stringify(rendered.preferred)).toContain('this line is much lo…');
    expect(JSON.stringify(rendered.preferred)).toContain('Rows were truncated');
  });

  it('degrades rows with more than maxStyledSegmentsPerLine spans to plain text and records a footer note', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot({
        rows: [
          {
            text: 'red green yellow',
            spans: [
              { text: 'red', color: 'red' },
              { text: ' green', color: 'green' },
              { text: ' yellow', color: 'yellow' },
            ],
          },
        ],
      }),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    expect(JSON.stringify(rendered.preferred)).toContain('red green yellow');
    expect(JSON.stringify(rendered.preferred)).toContain('Some rows were rendered as plain text');
  });
});
