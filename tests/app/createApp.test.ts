import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../../src/app/createApp.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForAssertion(assertion: () => Promise<void> | void, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(10);
    }
  }
  if (lastError) {
    throw lastError;
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

describe('createApp', () => {
  it('wires dependencies and exposes health', async () => {
    const root = await createTmpDir();
    const app = createApp({
      projectRoot: root,
      config: sampleConfig(root),
      store: new FileStateStore(root),
      codexRunner: new FakeCodexRunner(),
    });

    await expect(app.healthCheck()).resolves.toEqual({ ok: true });
  });

  it('passes notifier dependency to SessionManager', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn() };

    const app = createApp({ projectRoot: root, config: sampleConfig(root), store, codexRunner: runner, notifier });

    expect((app.sessionManager as any).deps.notifier).toBe(notifier);
  });

  it('auto-resumes the current Codex session on startup recovery', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const codexSessionId = '019e8271-ddb8-7540-9baa-77ce58da1f26';
    await store.saveSession({
      id: 'sess_last',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T09:09:20.569Z',
      updatedAt: '2026-06-01T09:19:01.493Z',
      logPath: store.sessionLogPath('sess_last'),
      codexSessionId,
    });
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      currentSessionId: 'sess_last',
    });
    const app = createApp({
      projectRoot: root,
      config: sampleConfig(root),
      store,
      codexRunner: runner,
    });

    await app.recoverStartupState();

    await expect(store.getSession('sess_last')).resolves.toMatchObject({
      status: 'interrupted',
      lastSummary: 'Interrupted during bot restart recovery.',
    });
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'resume', target: codexSessionId },
    });
    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBe(runner.starts[0].sessionId);
    await expect(store.getSession(runner.starts[0].sessionId)).resolves.toMatchObject({
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      codexSessionId,
      resumedFromSessionId: 'sess_last',
      resumeSource: 'code_bot',
    });
  });

  it('observes auto-resumed session output for completion notifications', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-01T10:00:00.000Z'));
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    await store.saveSession({
      id: 'sess_last',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T09:09:20.569Z',
      updatedAt: '2026-06-01T09:19:01.493Z',
      logPath: store.sessionLogPath('sess_last'),
      codexSessionId: '019e8271-ddb8-7540-9baa-77ce58da1f26',
    });
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      currentSessionId: 'sess_last',
    });
    const app = createApp({
      projectRoot: root,
      config: sampleConfig(root),
      store,
      codexRunner: runner,
      notifier,
    });

    await app.recoverStartupState();
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await app.sessionManager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '当前分支是什么？' });

    await runner.emitOutput(
      sessionId,
      [
        '────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────',
        '',
        '• 当前分支是：',
        '  feat/codex-completion-notifications',
      ].join('\n'),
    );

    await waitForAssertion(() => {
      expect(notifier.sendText).toHaveBeenCalledWith(
        'oc_1',
        'Codex 已完成：repo\n\n• 当前分支是：\nfeat/codex-completion-notifications',
      );
    });
    const events = (await readFile(join(root, '.code-bot/events/2026-06-01.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'notification.turn_completed',
          data: expect.objectContaining({ sessionId, chatId: 'oc_1', projectId: 'repo' }),
        }),
      ]),
    );
  });
});
