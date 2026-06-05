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

    const fallbackText = rendered.fallback.kind === 'text' ? rendered.fallback.text : '';
    const truncatedRow = fallbackText.split('\n').find((line) => line.startsWith('this line'));
    expect(truncatedRow).toBe('this line is much l…');
    expect(truncatedRow?.length).toBeLessThanOrEqual(config.cardMaxLineChars);
    expect(JSON.stringify(rendered.preferred)).toContain('this line is much l…');
    expect(JSON.stringify(rendered.preferred)).toContain('Rows were truncated');
  });

  it('preserves blank rows within the rendered cardMaxRows window', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot({
        rows: [
          { text: 'top', spans: [] },
          { text: '', spans: [] },
          { text: 'middle', spans: [] },
          { text: '', spans: [] },
        ],
      }),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    expect(cardBodyElements(rendered.preferred)).toHaveLength(5);
    const rowContents = cardBodyElements(rendered.preferred).slice(1).map((element) => element.content ?? '');
    expect(rowContents[0]).toContain('top');
    expect(rowContents[1]).toContain(' ');
    expect(rowContents[2]).toContain('middle');
    expect(rowContents[3]).toContain(' ');
    expect(rendered.fallback.kind === 'text' ? rendered.fallback.text : '').toContain('top\n \nmiddle\n ');
  });

  it('escapes Feishu markdown tags and backticks in terminal rows and metadata', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot({
        notes: ['note </font><at id="ou_note"></at>&'],
        rows: [
          {
            text: '</font><at id="ou_bad"></at>& `tick` ```',
            spans: [{ text: '</font><at id="ou_bad"></at>& `tick` ```', color: 'red' }],
          },
        ],
      }),
      config: { ...config, cardMaxLineChars: 80 },
      sessionId: 'sess_`1`',
      projectId: '</font><at id="ou_project"></at>&',
      status: 'running',
    });

    const preferredJson = JSON.stringify(rendered.preferred);
    expect(preferredJson).not.toContain('<at');
    expect(preferredJson).not.toContain('</font><at');
    expect(preferredJson).toContain('&lt;/font&gt;&lt;at id=\\"ou');
    expect(preferredJson).toContain('bad\\"&gt;&lt;/at&gt;&amp;');
    expect(preferredJson).toContain('&lt;/font&gt;&lt;at id=\\"ou_project\\"&gt;&lt;/at&gt;&amp;');
    expect(preferredJson).toContain('note\\"&gt;&lt;/at&gt;&amp;');
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

  it('records a footer note when styled rows are too complex to preserve', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot({
        rows: [
          {
            text: 'plain prefix red',
            spans: [{ text: 'red', color: 'red' }],
          },
        ],
      }),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    expect(JSON.stringify(rendered.preferred)).toContain('plain prefix red');
    expect(JSON.stringify(rendered.preferred)).toContain(
      'Some rows were rendered as plain text because their styles are too complex.',
    );
  });
});

function cardBodyElements(message: ReturnType<typeof renderCurrentScreenCard>['preferred']): Array<{ content?: string }> {
  if (message.kind !== 'card') {
    throw new Error('expected card');
  }

  const body = message.payload.body as { elements?: Array<{ content?: string }> } | undefined;
  return body?.elements ?? [];
}
