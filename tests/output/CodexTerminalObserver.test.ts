import { describe, expect, it } from 'vitest';
import { CodexTerminalObserver } from '../../src/output/CodexTerminalObserver.js';

const config = {
  cols: 40,
  rows: 6,
  scrollback: 20,
  replayMaxBytes: 4096,
  cardMaxRows: 6,
  cardMaxLineChars: 80,
  maxStyledSegmentsPerLine: 8,
};

describe('CodexTerminalObserver', () => {
  it('keeps live snapshots per session', () => {
    const observer = new CodexTerminalObserver(config);

    observer.write('sess_1', 'hello\n');
    observer.write('sess_2', 'other\n');

    expect(observer.snapshot('sess_1')?.rows.map((row) => row.text).join('\n')).toContain('hello');
    expect(observer.snapshot('sess_2')?.rows.map((row) => row.text).join('\n')).toContain('other');
  });

  it('keeps final snapshot after session end and can forget it', () => {
    const observer = new CodexTerminalObserver(config);

    observer.write('sess_1', 'final screen\n');
    observer.end('sess_1');

    expect(observer.snapshot('sess_1')?.rows.map((row) => row.text).join('\n')).toContain('final screen');

    observer.forget('sess_1');
    expect(observer.snapshot('sess_1')).toBeUndefined();
  });
});
