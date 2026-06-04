import { describe, expect, it } from 'vitest';
import { parseIncomingText } from '../../src/commands/CommandRouter.js';

describe('parseIncomingText', () => {
  it('treats a leading group mention before a slash command as a command', () => {
    expect(parseIncomingText('@_user_1 /projects')).toEqual({
      kind: 'command',
      name: 'projects',
      args: [],
      raw: '/projects',
    });
  });

  it('parses /model with no args as a command', () => {
    expect(parseIncomingText('/model')).toEqual({
      kind: 'command',
      name: 'model',
      args: [],
      raw: '/model',
    });
  });

  it('parses /upgrade as a command', () => {
    expect(parseIncomingText('/upgrade')).toEqual({
      kind: 'command',
      name: 'upgrade',
      args: [],
      raw: '/upgrade',
    });
  });

  it('parses /model with model and reasoning args as a command', () => {
    expect(parseIncomingText('/model gpt-5.5 high')).toEqual({
      kind: 'command',
      name: 'model',
      args: ['gpt-5.5', 'high'],
      raw: '/model gpt-5.5 high',
    });
  });
});
