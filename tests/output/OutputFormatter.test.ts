import { describe, expect, it } from 'vitest';
import { formatOutput, formatTail } from '../../src/output/OutputFormatter.js';

describe('OutputFormatter', () => {
  it('returns direct output when text is short', () => {
    expect(formatOutput('done', { directMaxChars: 10, chunkSize: 5 })).toEqual({ kind: 'direct', chunks: ['done'] });
  });

  it('chunks long output', () => {
    expect(formatOutput('abcdefghijkl', { directMaxChars: 5, chunkSize: 4 })).toEqual({
      kind: 'summary',
      chunks: ['abcd', 'efgh', 'ijkl'],
      summary: 'Output is 12 characters across 3 chunks. Use /tail to inspect local logs.',
    });
  });

  it('formats tail lines', () => {
    expect(formatTail(['one', 'two'])).toBe('```text\none\ntwo\n```');
  });
});
