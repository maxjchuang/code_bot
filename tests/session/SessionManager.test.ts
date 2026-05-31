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

    const sessionsReply = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/status',
    });
    expect(sessionsReply.reply).toBe('No active session.');

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    const content = await readFile(eventPath, 'utf8');
    expect(content).toContain('"type":"session.start_failed"');
    expect(content).toContain('"reason":"spawn failed"');
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

  it('keeps previous chat currentSessionId when replacement start fails', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const first = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });
    expect(first.reply).toContain('Created session');
    const originalSessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    runner.startError = new Error('spawn failed');
    const second = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });
    expect(second.reply).toContain('Failed to start Codex');

    const chatAfterFailure = await store.getChat('oc_1');
    expect(chatAfterFailure?.currentSessionId).toBe(originalSessionId);

    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'still works',
    });
    expect(sent.reply).toContain('Sent to Codex');
    expect(runner.sentMessages).toEqual(['still works']);
  });

  it('handles runner send failure by marking interrupted and returning no-running-session', async () => {
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
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    runner.dropSession(sessionId);
    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'inspect status',
    });
    expect(sent.reply).toBe('No running session. Run /new <project> first.');

    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('interrupted');
    expect(session?.lastSummary).toContain('Failed to send to Codex: Unknown fake session');

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    const content = await readFile(eventPath, 'utf8');
    expect(content).toContain('"type":"session.send_failed"');
  });

  it('preserves send-failure summary when exit arrives later', async () => {
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
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    runner.dropSession(sessionId);
    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'inspect status',
    });
    expect(sent.reply).toBe('No running session. Run /new <project> first.');

    const interrupted = await store.getSession(sessionId);
    expect(interrupted?.status).toBe('interrupted');
    const summaryBeforeExit = interrupted?.lastSummary;
    expect(summaryBeforeExit).toContain('Failed to send to Codex: Unknown fake session');

    await runner.exit(sessionId, 137);
    const exited = await store.getSession(sessionId);
    expect(exited?.status).toBe('exited');
    expect(exited?.exitCode).toBe(137);
    expect(exited?.lastSummary).toBe(summaryBeforeExit);
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

  it('supports /use, /status, and /tail', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    await expect(manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo' })).resolves.toEqual({
      reply: 'Current project set to repo.',
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new' });

    const status = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });
    expect(status.reply).toContain('Project: repo');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 10' });
    expect(tail.reply).toContain('```text');
  });
});
