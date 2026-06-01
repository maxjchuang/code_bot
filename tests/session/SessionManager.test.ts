import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { createTmpDir } from '../helpers/tmp.js';
import { FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';
import type { BotConfig } from '../../src/domain/types.js';
import type { CodexRunOptions, CodexRunner } from '../../src/codex/CodexRunner.js';

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

  it('keeps previous chat currentSessionId when replacement start fails after prior session exits', async () => {
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
    await runner.exit(originalSessionId, 0);

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
  });

  it('rejects /new repo2 while the current session is running', async () => {
    class CountingRunner extends FakeCodexRunner {
      readonly starts: CodexRunOptions[] = [];

      async start(options: CodexRunOptions): Promise<void> {
        this.starts.push(options);
        await super.start(options);
      }
    }

    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new CountingRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const first = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });
    expect(first.reply).toContain('Created session');
    const originalSessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const second = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo2',
    });
    expect(second.reply).toBe(`Current session ${originalSessionId} is still running. Run /stop and approve it before starting a new session.`);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBe(originalSessionId);
    expect(runner.starts).toHaveLength(1);
  });

  it('rejects /new repo while the current session is running', async () => {
    class CountingRunner extends FakeCodexRunner {
      readonly starts: CodexRunOptions[] = [];

      async start(options: CodexRunOptions): Promise<void> {
        this.starts.push(options);
        await super.start(options);
      }
    }

    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new CountingRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const first = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });
    expect(first.reply).toContain('Created session');
    const originalSessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const second = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });
    expect(second.reply).toBe(`Current session ${originalSessionId} is still running. Run /stop and approve it before starting a new session.`);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBe(originalSessionId);
    expect(runner.starts).toHaveLength(1);
  });

  it('serializes concurrent /new commands for the same chat', async () => {
    class CountingRunner extends FakeCodexRunner {
      readonly starts: CodexRunOptions[] = [];

      async start(options: CodexRunOptions): Promise<void> {
        this.starts.push(options);
        await super.start(options);
      }
    }

    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new CountingRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const [first, second] = await Promise.all([
      manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' }),
      manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' }),
    ]);

    const created = [first, second].filter((result) => result.reply.includes('Created session'));
    const rejected = [first, second].filter((result) => result.reply.includes('is still running'));
    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(runner.starts).toHaveLength(1);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBe(runner.starts[0].sessionId);
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

  it('preserves terminal exitCode when send fails after an exit callback', async () => {
    class SendExitBeforeThrowRunner implements CodexRunner {
      private optionsBySession = new Map<string, CodexRunOptions>();

      async healthCheck(): Promise<{ ok: true }> {
        return { ok: true };
      }

      async start(options: CodexRunOptions): Promise<void> {
        this.optionsBySession.set(options.sessionId, options);
      }

      async send(sessionId: string): Promise<void> {
        const options = this.optionsBySession.get(sessionId);
        if (!options) {
          throw new Error(`Unknown fake session: ${sessionId}`);
        }
        this.optionsBySession.delete(sessionId);
        await Promise.resolve(options.onExit(42));
        throw new Error('send pipe closed');
      }

      async stop(): Promise<void> {
        return;
      }
    }

    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new SendExitBeforeThrowRunner());

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });
    expect(sent.reply).toBe('No running session. Run /new <project> first.');

    await new Promise((resolve) => setTimeout(resolve, 10));
    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('exited');
    expect(session?.exitCode).toBe(42);
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
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await expect(manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo' })).resolves.toEqual({
      reply: 'Current project set to repo.',
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.emitOutput(sessionId, 'ready\n');

    const status = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });
    expect(status.reply).toContain('Project: repo');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 10' });
    expect(tail.reply).toContain('```text');
    expect(tail.reply).toContain('ready');
  });

  it('returns no active session for /tail and /rawtail before a session exists', async () => {
    const root = await createTmpDir();
    const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

    for (const command of ['/tail', '/rawtail']) {
      const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: command });
      expect(result.reply).toBe('No active session.');
    }
  });

  it('returns help command listing', async () => {
    const root = await createTmpDir();
    const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

    const help = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/help' });
    expect(help.reply).toContain('/help');
    expect(help.reply).toContain('/projects');
    expect(help.reply).toContain('/use <project>');
    expect(help.reply).toContain('/tail [n]');
    expect(help.reply).toContain('/rawtail [n]');
    expect(help.reply).toContain('Restrictions:');
    expect(help.reply).toContain('Allowed users: 1');
    expect(help.reply).toContain('Allowed chats: 1');
    expect(help.reply).toContain('Projects: repo, repo2');
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

  it('keeps running session current and stoppable when /use targets another project', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    const created = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    expect(created.reply).toContain('Created session');
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const switched = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo2' });
    expect(switched.reply).toBe(`Current session ${sessionId} is still running. Run /stop and approve it before switching projects.`);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBe(sessionId);

    const stopRequested = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    expect(stopRequested.reply).toContain('Approval required: Stop session');
    expect(stopRequested.reply).toContain(`Session: ${sessionId}`);
  });

  it('allows /use to switch projects after the current session exits', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.exit(sessionId, 0);

    const switched = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo2' });
    expect(switched.reply).toBe('Current project set to repo2.');

    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo2');
    expect(chat?.currentSessionId).toBeUndefined();
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

  it('sanitizes /tail output for Feishu readability', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    await runner.emitOutput(sessionId, '\u001b[?2004h\u001b[1;1H\u001b[J');
    await runner.emitOutput(sessionId, '╭────────────────────╮\n');
    await runner.emitOutput(sessionId, '│ >_ OpenAI Codex │\n');
    await runner.emitOutput(sessionId, '⚠ MCP startup incomplete (failed: figma)\n');
    await runner.emitOutput(sessionId, '› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件\n');
    await runner.emitOutput(sessionId, '/Users/bytedance/Projects/github/code_bot\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

    expect(tail.reply).toContain('```text');
    expect(tail.reply).toContain('⚠ MCP startup incomplete (failed: figma)');
    expect(tail.reply).toContain('› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件');
    expect(tail.reply).toContain('/Users/bytedance/Projects/github/code_bot');
    expect(tail.reply).not.toContain('\u001b[');
    expect(tail.reply).not.toContain('OpenAI Codex');
    expect(tail.reply).not.toContain('╭');
  });

  it('returns a helpful message when /tail has no readable output', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.emitOutput(sessionId, '\u001b[?2026h\u001b[14;2H\u001b[0m\u001b[49m\u001b[K\n');
    await runner.emitOutput(sessionId, '╭────────────────────╮\n╰────────────────────╯\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

    expect(tail.reply).toBe('No readable output yet. Use /rawtail 80 for raw terminal logs.');
  });

  it('returns raw terminal output with /rawtail', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.emitOutput(sessionId, '\u001b[?2004hraw terminal line\n');

    const rawtail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/rawtail 10' });

    expect(rawtail.reply).toContain('```text');
    expect(rawtail.reply).toContain('\u001b[?2004hraw terminal line');
  });

  it('defaults /tail to the latest 80 readable lines', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const lines = Array.from({ length: 85 }, (_, index) => `plain-line-${index + 1}`);
    await runner.emitOutput(sessionId, `${lines.join('\n')}\n`);

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail' });

    expect(tail.reply).toContain('plain-line-6');
    expect(tail.reply).toContain('plain-line-85');
    expect(tail.reply).not.toContain('\nplain-line-5\n');
  });

  it('defaults /rawtail to the latest 80 raw lines', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const lines = Array.from({ length: 85 }, (_, index) => `\u001b[${index + 1}mraw-line-${index + 1}`);
    await runner.emitOutput(sessionId, `${lines.join('\n')}\n`);

    const rawtail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/rawtail' });

    expect(rawtail.reply).toContain('\u001b[6mraw-line-6');
    expect(rawtail.reply).toContain('\u001b[85mraw-line-85');
    expect(rawtail.reply).not.toContain('\u001b[5mraw-line-5');
  });

  it('validates /rawtail count like /tail', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

    for (const value of ['10abc', '1e3', '0', '-1']) {
      const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/rawtail ${value}` });
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

  it('requests approval for /stop and stops only after /approve', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const stopRequested = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    expect(stopRequested.reply).toContain('Approval required: Stop session');
    expect(stopRequested.reply).toContain(`Session: ${sessionId}`);
    expect(stopRequested.reply).toContain('Approve: /approve ');

    const chatBeforeApprove = await store.getChat('oc_1');
    expect(chatBeforeApprove?.currentSessionId).toBe(sessionId);

    const approveMatch = stopRequested.reply.match(/Approve: \/approve (\S+)/);
    expect(approveMatch).toBeTruthy();
    const approvalId = approveMatch![1];
    const approved = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/approve ${approvalId}` });
    expect(approved.reply).toBe(`Stopped session ${sessionId}.`);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBeUndefined();
    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('interrupted');

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    const content = await readFile(eventPath, 'utf8');
    expect(content).toContain('"type":"session.stopped"');
  });

  it('rejecting stop approval does not stop the session', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const stopRequested = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    const rejectMatch = stopRequested.reply.match(/Reject: \/reject (\S+)/);
    expect(rejectMatch).toBeTruthy();
    const approvalId = rejectMatch![1];

    const rejected = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/reject ${approvalId}` });
    expect(rejected.reply).toContain(`Rejected approval ${approvalId}.`);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBe(sessionId);
    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('running');
  });

  it('does not stop or relabel a session that exited before stop approval', async () => {
    class CountingRunner extends FakeCodexRunner {
      stopCount = 0;

      async stop(sessionId: string): Promise<void> {
        this.stopCount += 1;
        await super.stop(sessionId);
      }
    }

    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new CountingRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const stopRequested = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    const approveMatch = stopRequested.reply.match(/Approve: \/approve (\S+)/);
    expect(approveMatch).toBeTruthy();

    await runner.exit(sessionId, 42);
    const approved = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/approve ${approveMatch![1]}` });
    expect(approved.reply).toBe(`Session ${sessionId} is already exited.`);

    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('exited');
    expect(session?.exitCode).toBe(42);
    expect(runner.stopCount).toBe(0);
  });

  it('rejects cross-chat approval resolution attempts', async () => {
    const root = await createTmpDir();
    const config: BotConfig = { ...sampleConfig(root), allowedChatIds: ['oc_1', 'oc_2'] };
    const store = new FileStateStore(root);
    const manager = new SessionManager(config, store, new FakeCodexRunner());

    await store.saveApproval({
      id: 'ap_cross_chat',
      sessionId: 'sess_1',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      action: 'stop_session',
      status: 'pending',
      riskSummary: 'Stop session sess_1',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const attempted = await manager.handleText({ chatId: 'oc_2', chatType: 'group', userId: 'ou_1', text: '/approve ap_cross_chat' });
    expect(attempted.reply).toBe('Approval does not belong to this chat: ap_cross_chat');
    expect((await store.getApproval('ap_cross_chat'))?.status).toBe('pending');
  });

  it('keeps interrupted status when exit callback arrives after approved stop', async () => {
    class StopExitRaceRunner implements CodexRunner {
      private optionsBySession = new Map<string, CodexRunOptions>();
      async healthCheck(): Promise<{ ok: true }> {
        return { ok: true };
      }
      async start(options: CodexRunOptions): Promise<void> {
        this.optionsBySession.set(options.sessionId, options);
      }
      async send(): Promise<void> {
        return;
      }
      async stop(sessionId: string): Promise<void> {
        const options = this.optionsBySession.get(sessionId);
        if (!options) {
          throw new Error(`Unknown fake session: ${sessionId}`);
        }
        this.optionsBySession.delete(sessionId);
        setTimeout(() => {
          void Promise.resolve(options.onExit(0));
        }, 0);
      }
    }

    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new StopExitRaceRunner());

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const stopRequested = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    const approveMatch = stopRequested.reply.match(/Approve: \/approve (\S+)/);
    expect(approveMatch).toBeTruthy();
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/approve ${approveMatch![1]}` });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('interrupted');
    expect(session?.exitCode).toBe(0);
  });

  it('preserves exitCode when stop emits fire-and-forget exit callback', async () => {
    class StopExitBeforeResolveRunner implements CodexRunner {
      private optionsBySession = new Map<string, CodexRunOptions>();
      async healthCheck(): Promise<{ ok: true }> {
        return { ok: true };
      }
      async start(options: CodexRunOptions): Promise<void> {
        this.optionsBySession.set(options.sessionId, options);
      }
      async send(): Promise<void> {
        return;
      }
      async stop(sessionId: string): Promise<void> {
        const options = this.optionsBySession.get(sessionId);
        if (!options) {
          throw new Error(`Unknown fake session: ${sessionId}`);
        }
        this.optionsBySession.delete(sessionId);
        void Promise.resolve(options.onExit(143));
      }
    }

    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new StopExitBeforeResolveRunner());

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const stopRequested = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    const approveMatch = stopRequested.reply.match(/Approve: \/approve (\S+)/);
    expect(approveMatch).toBeTruthy();

    const approved = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: `/approve ${approveMatch![1]}`,
    });
    expect(approved.reply).toBe(`Stopped session ${sessionId}.`);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('interrupted');
    expect(session?.exitCode).toBe(143);
  });

  it('lists sessions with /sessions and has empty-state fallback', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    const empty = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/sessions' });
    expect(empty.reply).toContain('No sessions for this chat yet');

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const listed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/sessions' });
    expect(listed.reply).toContain('repo');
    expect(listed.reply).toContain('running');
  });

  it('supports /approve and /reject approval commands', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    await store.saveApproval({
      id: 'ap_pending_approve',
      sessionId: 'sess_1',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      status: 'pending',
      riskSummary: 'approve me',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const approved = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/approve ap_pending_approve' });
    expect(approved.reply).toContain('Approved approval ap_pending_approve.');
    expect((await store.getApproval('ap_pending_approve'))?.status).toBe('approved');

    await store.saveApproval({
      id: 'ap_pending_reject',
      sessionId: 'sess_1',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      status: 'pending',
      riskSummary: 'reject me',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const rejected = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/reject ap_pending_reject' });
    expect(rejected.reply).toContain('Rejected approval ap_pending_reject.');
    expect((await store.getApproval('ap_pending_reject'))?.status).toBe('rejected');
  });

  it('returns useful fallback errors for /approve and /reject', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    const usageApprove = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/approve' });
    expect(usageApprove.reply).toBe('Usage: /approve <id>');
    const usageReject = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/reject' });
    expect(usageReject.reply).toBe('Usage: /reject <id>');

    const notFound = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/approve missing_id' });
    expect(notFound.reply).toBe('Approval not found: missing_id');

    await store.saveApproval({
      id: 'ap_expired',
      sessionId: 'sess_1',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      status: 'pending',
      riskSummary: 'expired',
      createdAt: '2026-05-31T10:00:00.000Z',
      expiresAt: '2026-05-31T10:00:00.000Z',
    });
    const expired = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/reject ap_expired' });
    expect(expired.reply).toBe('Approval expired: ap_expired');
  });
});
