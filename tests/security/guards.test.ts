import { describe, expect, it } from 'vitest';
import { isAuthorizedMessage, resolveProject } from '../../src/security/guards.js';
import type { BotConfig } from '../../src/domain/types.js';

const config: BotConfig = {
  feishu: { appId: 'cli', appSecret: 'secret' },
  allowedUsers: ['ou_1'],
  allowedChatIds: ['oc_1'],
  restrictUsers: true,
  restrictChatIds: true,
  projects: [{ id: 'repo', name: 'Repo', path: '/tmp/repo', codexArgs: [] }],
  output: {
    directMaxChars: 1800,
    chunkSize: 1500,
    terminalSnapshot: {
      cols: 120,
      rows: 40,
      scrollback: 200,
      replayMaxBytes: 262144,
      cardMaxRows: 40,
      cardMaxLineChars: 160,
      maxStyledSegmentsPerLine: 8,
    },
  },
  codex: { command: 'codex', defaultArgs: [] },
  logLevel: 'info',
  ui: { verbosity: 'normal' },
  notifications: { enabled: true, idleMs: 3000, maxFinalChars: 8000, failureTailChars: 2000 },
  upgrade: {
    enabled: false,
    adminUsers: [],
    pm2ProcessName: 'code-bot',
    remote: 'origin',
    branch: 'main',
  },
};

describe('security guards', () => {
  it('allows private messages from allowlisted users', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'ou_1', chatType: 'private' })).toBe(true);
  });

  it('denies private messages from non-allowlisted users', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_not_allowed', chatId: 'ou_not_allowed', chatType: 'private' })).toBe(false);
  });

  it('denies group messages from allowlisted chat when user is non-allowlisted', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_not_allowed', chatId: 'oc_1', chatType: 'group' })).toBe(false);
  });

  it('allows group messages from allowlisted users in allowlisted chats', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'oc_1', chatType: 'group' })).toBe(true);
  });

  it('blocks group messages outside the chat allowlist', () => {
    expect(isAuthorizedMessage(config, { userId: 'ou_1', chatId: 'oc_other', chatType: 'group' })).toBe(false);
  });

  it('allows all users and chats when restriction switches are disabled', () => {
    const unrestricted: BotConfig = {
      ...config,
      restrictUsers: false,
      restrictChatIds: false,
      allowedUsers: [],
      allowedChatIds: [],
    };

    expect(isAuthorizedMessage(unrestricted, { userId: 'ou_any', chatId: 'ou_any', chatType: 'private' })).toBe(true);
    expect(isAuthorizedMessage(unrestricted, { userId: 'ou_any', chatId: 'oc_any', chatType: 'group' })).toBe(true);
  });

  it('only applies chat allowlist when chat restriction is enabled', () => {
    const groupRestricted: BotConfig = {
      ...config,
      restrictUsers: false,
      restrictChatIds: true,
      allowedUsers: [],
      allowedChatIds: ['oc_1'],
    };

    expect(isAuthorizedMessage(groupRestricted, { userId: 'ou_any', chatId: 'oc_1', chatType: 'group' })).toBe(true);
    expect(isAuthorizedMessage(groupRestricted, { userId: 'ou_any', chatId: 'oc_2', chatType: 'group' })).toBe(false);
  });

  it('resolves projects by id only', () => {
    expect(resolveProject(config, 'repo')?.path).toBe('/tmp/repo');
    expect(resolveProject(config, '/tmp/repo')).toBeUndefined();
  });
});
