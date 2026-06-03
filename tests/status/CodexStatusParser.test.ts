import { describe, expect, it } from 'vitest';
import { parseCodexStatusText } from '../../src/status/CodexStatusParser.js';

describe('parseCodexStatusText', () => {
  it('extracts stable labeled fields from native status text', () => {
    const parsed = parseCodexStatusText(`
Status: running
Task: Implement status integration
Progress: waiting for tests
Context window: 61% used
Tokens: 12345 input, 678 output
Model: gpt-5-codex
CWD: /repo
    `);

    expect(parsed).toEqual({
      statusLine: 'running',
      currentTask: 'Implement status integration',
      progressHint: 'waiting for tests',
      contextWindow: '61% used',
      tokenUsage: '12345 input, 678 output',
      model: 'gpt-5-codex',
      cwd: '/repo',
    });
  });

  it('keeps partial results when only some fields are recognized', () => {
    const parsed = parseCodexStatusText(`
Status: idle
Model: gpt-5-codex
Unrecognized: keep in raw text only
    `);

    expect(parsed).toEqual({
      statusLine: 'idle',
      model: 'gpt-5-codex',
    });
  });

  it('returns an empty summary when no known fields are found', () => {
    expect(parseCodexStatusText('plain text without labels')).toEqual({});
  });
});
