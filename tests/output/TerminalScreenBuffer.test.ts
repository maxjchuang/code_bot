import { describe, expect, it } from 'vitest';
import { TerminalScreenBuffer, replayTerminalSnapshot } from '../../src/output/TerminalScreenBuffer.js';

const config = {
  cols: 40,
  rows: 6,
  scrollback: 20,
  replayMaxBytes: 4096,
  cardMaxRows: 6,
  cardMaxLineChars: 80,
  maxStyledSegmentsPerLine: 8,
};

describe('TerminalScreenBuffer', () => {
  it('renders cursor movement and erase-line sequences into the final viewport', () => {
    const buffer = new TerminalScreenBuffer(config);

    buffer.write('old status');
    buffer.write('\r\u001b[Knew status\n');
    buffer.write('second line');

    expect(buffer.snapshot().rows.map((row) => row.text).filter(Boolean)).toEqual(['new status', 'second line']);
  });

  it('preserves Codex-like TUI layout text', () => {
    const buffer = new TerminalScreenBuffer(config);

    buffer.write('╭────────────╮\n');
    buffer.write('│ >_ Codex   │\n');
    buffer.write('╰────────────╯\n');
    buffer.write('⚠ MCP startup incomplete\n');
    buffer.write('› 只读查看当前目录\n');

    expect(buffer.snapshot().rows.map((row) => row.text).join('\n')).toContain('› 只读查看当前目录');
  });

  it('extracts bounded style spans for common ANSI colors and bold text', () => {
    const buffer = new TerminalScreenBuffer(config);

    buffer.write('\u001b[1mBold\u001b[0m \u001b[31mError\u001b[0m \u001b[33mWarn\u001b[0m');

    const rows = buffer.snapshot().rows.filter((row) => row.text.trim() !== '');
    expect(rows[0]?.text).toContain('Bold Error Warn');
    expect(rows[0]?.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Bold', bold: true }),
        expect.objectContaining({ text: 'Error', color: 'red' }),
        expect.objectContaining({ text: 'Warn', color: 'yellow' }),
      ]),
    );
  });

  it('replays only the newest bounded bytes', () => {
    const snapshot = replayTerminalSnapshot(['old line\n', 'x'.repeat(5000), '\nnew line\n'], {
      ...config,
      replayMaxBytes: 64,
    });

    const text = snapshot.rows.map((row) => row.text).join('\n');
    expect(text).toContain('new line');
    expect(text).not.toContain('old line');
    expect(snapshot.truncated).toBe(true);
  });
});
