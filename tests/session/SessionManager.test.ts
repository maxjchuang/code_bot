import { describe, expect, it } from 'vitest';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { createTmpDir } from '../helpers/tmp.js';
import { FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';

describe('SessionManager', () => {
  it('creates a session and sends normal messages to Codex', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const created = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });
    expect(created.reply).toContain('Created session');

    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'inspect status',
    });
    expect(sent.reply).toContain('Sent to Codex');
    expect(runner.sentMessages).toEqual(['inspect status']);
  });

  it('blocks unauthorized users', async () => {
    const root = await createTmpDir();
    const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

    const result = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_blocked',
      text: '/status',
    });

    expect(result.reply).toBe('You are not allowed to control this bot.');
  });
});
