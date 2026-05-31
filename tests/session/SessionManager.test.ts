import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { createTmpDir } from '../helpers/tmp.js';
import { FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';
import type { BotConfig } from '../../src/domain/types.js';

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
    expect(sessionsReply.reply).toContain('Project: none');
    expect(sessionsReply.reply).toContain('Session: none');
    expect(sessionsReply.reply).toContain('Status: none');

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

  it('returns help command listing', async () => {
    const root = await createTmpDir();
    const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

    const help = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/help' });
    expect(help.reply).toContain('/projects');
    expect(help.reply).toContain('/use <project>');
    expect(help.reply).toContain('/tail [n]');
    expect(help.reply).toContain('Restrictions:');
    expect(help.reply).toContain('Allowed users: 1');
    expect(help.reply).toContain('Allowed chats: 1');
    expect(help.reply).toContain('Projects: repo');
  });

  it('includes session summary and pending approvals in /status', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const session = (await store.getSession(sessionId))!;
    await store.saveSession({ ...session, lastSummary: 'recent work summary' });
    await store.saveApproval({
      id: 'ap_1',
      sessionId,
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      status: 'pending',
      riskSummary: 'needs approval',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.saveApproval({
      id: 'ap_2',
      sessionId,
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      status: 'approved',
      riskSummary: 'approved',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      resolvedBy: 'ou_1',
      resolvedAt: new Date().toISOString(),
    });

    const status = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });
    expect(status.reply).toContain('Project: repo');
    expect(status.reply).toContain(`Session: ${sessionId}`);
    expect(status.reply).toContain('Status: running');
    expect(status.reply).toContain('Summary: recent work summary');
    expect(status.reply).toContain('Pending approvals: ap_1');
    expect(status.reply).not.toContain('ap_2');
  });

  it('clears active session when switching to another project with /use', async () => {
    const root = await createTmpDir();
    const config: BotConfig = {
      ...sampleConfig(root),
      projects: [
        ...sampleConfig(root).projects,
        { id: 'repo2', name: 'Repo 2', path: root, codexArgs: [] },
      ],
    };
    const store = new FileStateStore(root);
    const manager = new SessionManager(config, store, new FakeCodexRunner());

    const created = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    expect(created.reply).toContain('Created session');
    expect((await store.getChat('oc_1'))?.currentSessionId).toBeTruthy();

    const switched = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo2' });
    expect(switched.reply).toBe('Current project set to repo2.');

    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo2');
    expect(chat?.currentSessionId).toBeUndefined();

    const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'hello' });
    expect(sent.reply).toBe('No active session. Run /projects and /new <project> first.');
  });

  it('validates /tail count and rejects invalid values', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

    const invalids = ['10abc', '1e3', '0', '-1'];
    for (const value of invalids) {
      const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/tail ${value}` });
      expect(result.reply).toBe('Invalid tail count.');
    }
  });

  it('tails only the requested number of latest lines', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    await runner.emitOutput(sessionId, 'line-1\n');
    await runner.emitOutput(sessionId, 'line-2\n');
    await runner.emitOutput(sessionId, 'line-3\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 2' });
    expect(tail.reply).toContain('line-2');
    expect(tail.reply).toContain('line-3');
    expect(tail.reply).not.toContain('line-1');
  });
});
