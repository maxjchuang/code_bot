import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

  it('returns a start failure reply and records start_failed event', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    runner.startError = new Error('spawn failed');
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const created = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });
    expect(created.reply).toContain('Failed to start Codex');

    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBeTruthy();
    const session = await store.getSession(chat!.currentSessionId!);
    expect(session?.status).toBe('exited');
    expect(session?.lastSummary).toContain('Failed to start Codex: spawn failed');

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    const content = await readFile(eventPath, 'utf8');
    expect(content).toContain('"type":"session.start_failed"');
  });

  it('blocks sends when current session has exited', async () => {
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

    const firstSend = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'inspect status',
    });
    expect(firstSend.reply).toContain('Sent to Codex');
    expect(runner.sentMessages).toEqual(['inspect status']);

    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.emitOutput(sessionId, 'hello from codex\n');
    await runner.exit(sessionId, 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const logLines = await store.tailSessionLog(sessionId, 10);
    expect(logLines).toContain('hello from codex');
    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('exited');
    expect(session?.exitCode).toBe(0);

    const secondSend = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'inspect again',
    });
    expect(secondSend.reply).toBe('No running session. Run /new <project> first.');
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
