import { describe, expect, it } from 'vitest';
import { parseIncomingText } from '../../src/commands/CommandRouter.js';

describe('parseIncomingText', () => {
  it('parses slash commands with arguments', () => {
    expect(parseIncomingText('/new repo')).toEqual({ kind: 'command', name: 'new', args: ['repo'], raw: '/new repo' });
    expect(parseIncomingText('/new\trepo')).toEqual({ kind: 'command', name: 'new', args: ['repo'], raw: '/new\trepo' });
    expect(parseIncomingText('/tail 120')).toEqual({ kind: 'command', name: 'tail', args: ['120'], raw: '/tail 120' });
    expect(parseIncomingText('/rawtail 120')).toEqual({
      kind: 'command',
      name: 'rawtail',
      args: ['120'],
      raw: '/rawtail 120',
    });
  });

  it('treats non-command text as codex input', () => {
    expect(parseIncomingText('please inspect this repo')).toEqual({ kind: 'message', text: 'please inspect this repo' });
  });

  it('preserves send payload after command name', () => {
    expect(parseIncomingText('/send explain /status literally')).toEqual({
      kind: 'command',
      name: 'send',
      args: ['explain /status literally'],
      raw: '/send explain /status literally',
    });

    const sendWithTab = '/send\texplain /status literally';
    expect(parseIncomingText(sendWithTab)).toEqual({
      kind: 'command',
      name: 'send',
      args: ['explain /status literally'],
      raw: sendWithTab,
    });

    const sendWithArbitraryWhitespace = '/send\t\texplain   /status\tliterally';
    expect(parseIncomingText(sendWithArbitraryWhitespace)).toEqual({
      kind: 'command',
      name: 'send',
      args: ['explain   /status\tliterally'],
      raw: sendWithArbitraryWhitespace,
    });
  });
});
