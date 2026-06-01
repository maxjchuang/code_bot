import { describe, expect, it } from 'vitest';
import { extractFinalAnswer, formatCompletionNotification } from '../../src/notifications/FinalAnswerExtractor.js';

describe('FinalAnswerExtractor', () => {
  it('extracts the final Chinese answer from noisy Codex TUI output', () => {
    const result = extractFinalAnswer({
      rawLines: [
        '\u001b[?2026h╭───────────────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.135.0) │',
        '› 当前分支是什么',
        '• Working',
        'WWo•Wor•WorkWorking',
        '• Ran git branch --show-current',
        '└ develop',
        '────────────────────────────────────────────────────────────────',
        '当前分支：develop',
        '当前提交：079db17d',
        '工作区状态：干净，跟踪 origin/develop。',
      ],
      prompt: '当前分支是什么',
      maxChars: 8000,
    });

    expect(result).toEqual({
      kind: 'answer',
      text: ['当前分支：develop', '当前提交：079db17d', '工作区状态：干净，跟踪 origin/develop。'].join('\n'),
    });
  });

  it('does not treat MCP warnings and startup progress as a successful answer', () => {
    const result = extractFinalAnswer({
      rawLines: [
        'Starting MCP servers (0/7): FeishuProjectMcp, codebase',
        '⚠ The figma MCP server is not logged in. Run `codex mcp login figma`.',
        '⚠ MCP startup incomplete (failed: FeishuProjectMcp, codebase, figma, scm)',
        '› Explain this codebase',
        'gpt-5.5 medium · Context 0% used',
      ],
      prompt: 'Explain this codebase',
      maxChars: 8000,
    });

    if (result.kind !== 'empty') {
      throw new Error(`Expected empty extraction, received ${result.kind}`);
    }
    expect(result.reason).toContain('No final answer');
  });

  it('filters prompt echo and spinner fragments', () => {
    const result = extractFinalAnswer({
      rawLines: [
        '› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
        '只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
        '•Working•orking•rking•king•ingngg',
        '当前目录是 /Users/bytedance/Projects/github/code_bot。',
      ],
      prompt: '只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
      maxChars: 8000,
    });

    expect(result).toEqual({
      kind: 'answer',
      text: '当前目录是 /Users/bytedance/Projects/github/code_bot。',
    });
  });

  it('scopes the final answer after the last divider before filtering divider text', () => {
    const result = extractFinalAnswer({
      rawLines: [
        'Codex 已完成：旧任务',
        '这是上一段输出，不应进入最终回答。',
        '────────────────────────────────────────────────────────────────',
        '• Ran git status --short',
        '└ clean',
        '最终回答：当前工作区干净。',
      ],
      prompt: '检查状态',
      maxChars: 8000,
    });

    expect(result).toEqual({
      kind: 'answer',
      text: '最终回答：当前工作区干净。',
    });
  });

  it('filters Codex status and quota lines without dropping legitimate answers', () => {
    const result = extractFinalAnswer({
      rawLines: [
        '› 总结',
        'gpt-5.5 medium · 5h 98% left · weekly 97% left · 29.6K used · Context 6% used',
        'status: background terminal running · /ps to view · /stop to close',
        'quota: daily 42% left',
        '状态：任务已经完成。',
        '配额：本次没有修改限制。',
      ],
      prompt: '总结',
      maxChars: 8000,
    });

    expect(result).toEqual({
      kind: 'answer',
      text: ['状态：任务已经完成。', '配额：本次没有修改限制。'].join('\n'),
    });
  });

  it('truncates long final answers with a tail hint', () => {
    const result = extractFinalAnswer({
      rawLines: ['第一行', '第二行', '第三行'],
      prompt: '总结',
      maxChars: 8,
    });

    if (result.kind !== 'answer') {
      throw new Error(`Expected answer extraction, received ${result.kind}`);
    }
    expect(result.text).toBe('第一行\n第二…\n\n输出已截断，可使用 /tail 查看完整内容。');
  });

  it('formats success and failure notifications', () => {
    expect(formatCompletionNotification({ projectId: 'repo', extraction: { kind: 'answer', text: '完成了' } })).toBe(
      'Codex 已完成：repo\n\n完成了',
    );
    expect(
      formatCompletionNotification({
        projectId: 'repo',
        sessionId: 'sess_1',
        extraction: { kind: 'empty', reason: 'No final answer detected.' },
      }),
    ).toBe('Codex 任务结束，但未能提取明确最终回答。\n\n原因：No final answer detected.\n可使用 /tail sess_1 查看最近输出。');
    expect(
      formatCompletionNotification({
        projectId: 'repo',
        extraction: { kind: 'failure', reason: 'Extractor failed.', diagnostic: 'raw buffer unavailable' },
      }),
    ).toBe('Codex 任务结束，但未能提取明确最终回答。\n\n原因：Extractor failed.\n\nraw buffer unavailable\n可使用 /tail 查看最近输出。');
  });
});
