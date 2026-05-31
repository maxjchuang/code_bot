import { describe, expect, it } from 'vitest';
import { isAuthorizedMessage, resolveProject } from '../../src/security/guards.js';
import type { BotConfig } from '../../src/domain/types.js';

const config: BotConfig = {
  feishu: { appId: 'cli', appSecret: 'secret' },
  allowedUsers: ['ou_1'],
  allowedChatIds: ['oc_1'],
  projects: [{ id: 'repo', name: 'Repo', path: '/tmp/repo', codexArgs: [] }],
  output: { directMaxChars: 1800, chunkSize: 1500 },
  codex: { command: 'codex', defaultArgs: [] },
};

describe('security guards', () => {
  it('allows private messages from allowlisted users', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'ou_1', chatType: 'private' })).toBe(true);
  });

  it('blocks group messages outside the chat allowlist', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'oc_other', chatType: 'group' })).toBe(false);
  });

  it('resolves projects by id only', () => {
    expect(resolveProject(config, 'repo')?.path).toBe('/tmp/repo');
    expect(resolveProject(config, '/tmp/repo')).toBeUndefined();
  });
});
