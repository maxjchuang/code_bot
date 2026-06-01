import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app/createApp.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

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
});
