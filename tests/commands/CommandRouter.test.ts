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
});
