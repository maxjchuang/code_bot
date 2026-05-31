import { describe, expect, it } from 'vitest';
import { sanitizeTerminalOutput } from '../../src/output/TerminalOutputSanitizer.js';

describe('sanitizeTerminalOutput', () => {
  it('strips ANSI, OSC, and terminal mode control sequences', () => {
    const result = sanitizeTerminalOutput([
      '\u001b[?2004h\u001b[1;1H\u001b[J\u001b[38;5;3m⚠ failed to start\u001b[39m',
      '\u001b]0;code_bot\u0007plain text\u001b[?25h',
    ]);

    expect(result.hadControlSequences).toBe(true);
    expect(result.readableLines).toEqual(['⚠ failed to start', 'plain text']);
    expect(result.removedLineCount).toBe(0);
  });

  it('strips single-character ESC terminal mode controls', () => {
    const result = sanitizeTerminalOutput([
      '\u001b=plain keypad application',
      '\u001b>plain keypad numeric',
      '\u001b7plain saved cursor',
      '\u001b8plain restored cursor',
    ]);

    expect(result.hadControlSequences).toBe(true);
    expect(result.readableLines).toEqual([
      'plain keypad application',
      'plain keypad numeric',
      'plain saved cursor',
      'plain restored cursor',
    ]);
    expect(result.removedLineCount).toBe(0);
  });

  it('filters Codex TUI banner and redraw noise while preserving useful lines', () => {
    const result = sanitizeTerminalOutput([
      '\u001b[2m╭───────────────────────────────────────╮',
      '│ >_  OpenAI Codex  (v0.133.0)            │',
      '│ model:      loading    /model to change │',
      '╰───────────────────────────────────────╯',
      '• Starting MCP servers (4/7): codex_apps, figma, scm (0s • esc to interrupt)',
      '⚠ The figma MCP server is not logged in. Run `codex mcp login figma`.',
      '⚠ MCP startup incomplete (failed: FeishuProjectMcp, codebase, figma, scm)',
      '› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
      '/Users/bytedance/Projects/github/code_bot',
      'README.md',
      'src',
      'tests',
    ]);

    expect(result.readableLines).toEqual([
      '⚠ The figma MCP server is not logged in. Run `codex mcp login figma`.',
      '⚠ MCP startup incomplete (failed: FeishuProjectMcp, codebase, figma, scm)',
      '› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
      '/Users/bytedance/Projects/github/code_bot',
      'README.md',
      'src',
      'tests',
    ]);
    expect(result.removedLineCount).toBeGreaterThanOrEqual(5);
  });

  it('deduplicates adjacent repeated lines and compresses blank lines', () => {
    const result = sanitizeTerminalOutput(['Tip: Try the Codex App.', 'Tip: Try the Codex App.', '', '', 'done', 'done']);

    expect(result.readableLines).toEqual(['Tip: Try the Codex App.', '', 'done']);
    expect(result.removedLineCount).toBe(3);
  });

  it('returns empty readable lines when only redraw noise remains', () => {
    const result = sanitizeTerminalOutput([
      '\u001b[?2026h\u001b[14;2H\u001b[0m\u001b[49m\u001b[K',
      '╭────────────────────╮',
      '╰────────────────────╯',
      '• Starting MCP servers (5/7): scm (1s • esc to interrupt)',
      '\u001b]0;⠹ code_bot\u0007',
    ]);

    expect(result.readableLines).toEqual([]);
    expect(result.removedLineCount).toBeGreaterThan(0);
    expect(result.hadControlSequences).toBe(true);
  });
});
