import { describe, expect, it } from 'vitest';
import { formatOutput, formatTail } from '../../src/output/OutputFormatter.js';

describe('OutputFormatter', () => {
  it('returns direct output when text is short', () => {
    expect(formatOutput('done', { directMaxChars: 10, chunkSize: 5 })).toEqual({ kind: 'direct', chunks: ['done'] });
  });

  it('returns direct output when text length equals directMaxChars', () => {
    expect(formatOutput('hello', { directMaxChars: 5, chunkSize: 4 })).toEqual({ kind: 'direct', chunks: ['hello'] });
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

  it('uses longer fence when tail contains code fences', () => {
    const output = formatTail(['```json', 'value']);
    expect(output.startsWith('````text\n')).toBe(true);
    expect(output.endsWith('\n````')).toBe(true);
  });

  it('throws on invalid output limits', () => {
    expect(() => formatOutput('abc', { directMaxChars: 2, chunkSize: 0 })).toThrow('Invalid output limits');
    expect(() => formatOutput('abc', { directMaxChars: -1, chunkSize: 2 })).toThrow('Invalid output limits');
    expect(() => formatOutput('abc', { directMaxChars: Number.POSITIVE_INFINITY, chunkSize: 2 })).toThrow('Invalid output limits');
    expect(() => formatOutput('abc', { directMaxChars: 2, chunkSize: 1.5 })).toThrow('Invalid output limits');
  });
});
