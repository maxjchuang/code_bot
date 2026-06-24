import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../../src/app/createApp.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { FakeCodexObservationStore, FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';
import type { CodexHookStatusReport } from '../../src/hooks/CodexHookTypes.js';

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
  const singleProjectConfig = (root: string) => {
    const config = sampleConfig(root);
    return { ...config, projects: [config.projects[0]] };
  };

  const notifierTargetMethods = {
    sendTextToTarget: vi.fn(),
    sendRenderedMessageToTarget: vi.fn(),
  };

  const hookStatusReport = (overrides: Partial<CodexHookStatusReport> = {}): CodexHookStatusReport => ({
    configured: true,
    configFeatureEnabled: true,
    hooksJsonValid: true,
    hooksJsonContainsManagedHooks: true,
    manifestValid: true,
    scriptInstalled: true,
    listenerRunning: false,
    recommendedCommand: '/hook-status',
    issues: [],
    ...overrides,
  });

  const createHookServiceFactory = () =>
    vi.fn(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn(() => true),
      resolvePermissionRequest: vi.fn(() => false),
    }));

  it('wires dependencies and exposes health', async () => {
    const root = await createTmpDir();
    const app = createApp({
      projectRoot: root,
      config: sampleConfig(root),
      store: new FileStateStore(root),
      codexRunner: new FakeCodexRunner(),
    });

    await expect(app.healthCheck()).resolves.toEqual({ ok: true });
    expect((app.sessionManager as any).deps.upgradeManager).toBeDefined();
  });

  it('passes notifier dependency to SessionManager', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn(), sendRenderedMessage: vi.fn(), ...notifierTargetMethods };

    const app = createApp({ projectRoot: root, config: sampleConfig(root), store, codexRunner: runner, notifier });

    expect((app.sessionManager as any).deps.notifier).toBe(notifier);
  });

  it('expires pending permission approvals during startup recovery', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:00.000Z'));
    await store.saveApproval({
      id: 'ap_pending',
      sessionId: 'sess_1',
      chatId: 'oc_1',
      requestedBy: 'hook',
      status: 'pending',
      riskSummary: 'Permission requested for shell',
      createdAt: '2026-06-23T23:59:00.000Z',
      expiresAt: '2026-06-24T00:04:00.000Z',
      hookRequestId: 'turn_1',
      toolName: 'shell',
      projectId: 'repo',
    });
    const app = createApp({
      projectRoot: root,
      config: sampleConfig(root),
      store,
      codexRunner: new FakeCodexRunner(),
      createCodexHookService: createHookServiceFactory(),
    });

    await app.recoverStartupState();

    await expect(store.getApproval('ap_pending')).resolves.toMatchObject({
      status: 'expired',
      failureReason: 'Bot restarted before permission decision.',
    });
    const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
    expect(events).toContain('"type":"approval.expired_startup_recovery"');
  });

  it('checks hook status on startup when codexHooks.enabled is true', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:00.000Z'));
    const hookInstaller = {
      status: vi.fn().mockResolvedValue(hookStatusReport()),
      install: vi.fn(),
      uninstall: vi.fn(),
    };
    const config = { ...sampleConfig(root), codexHooks: { ...sampleConfig(root).codexHooks, enabled: true } };
    createApp({
      projectRoot: root,
      config,
      store,
      codexRunner: new FakeCodexRunner(),
      codexHookInstaller: hookInstaller,
      createCodexHookService: createHookServiceFactory(),
    });

    await waitForAssertion(async () => {
      expect(hookInstaller.status).toHaveBeenCalledTimes(1);
      const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
      expect(events).toContain('"type":"hook.startup_status"');
    });
    expect(hookInstaller.install).not.toHaveBeenCalled();
  });

  it('does not repair hooks on startup when autoRepair is false', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:00.000Z'));
    const hookInstaller = {
      status: vi.fn().mockResolvedValue(hookStatusReport({ configured: false, recommendedCommand: '/install-hooks' })),
      install: vi.fn(),
      uninstall: vi.fn(),
    };
    const config = { ...sampleConfig(root), codexHooks: { ...sampleConfig(root).codexHooks, enabled: true, autoRepair: false } };

    createApp({
      projectRoot: root,
      config,
      store,
      codexRunner: new FakeCodexRunner(),
      codexHookInstaller: hookInstaller,
      createCodexHookService: createHookServiceFactory(),
    });

    await waitForAssertion(() => expect(hookInstaller.status).toHaveBeenCalledTimes(1));
    expect(hookInstaller.install).not.toHaveBeenCalled();
  });

  it('repairs managed hooks on startup when enabled and autoRepair is true', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:00.000Z'));
    const hookInstaller = {
      status: vi.fn().mockResolvedValue(hookStatusReport({ configured: false, recommendedCommand: '/install-hooks' })),
      install: vi.fn().mockResolvedValue({ installed: true, status: hookStatusReport() }),
      uninstall: vi.fn(),
    };
    const config = { ...sampleConfig(root), codexHooks: { ...sampleConfig(root).codexHooks, enabled: true, autoRepair: true } };

    createApp({
      projectRoot: root,
      config,
      store,
      codexRunner: new FakeCodexRunner(),
      codexHookInstaller: hookInstaller,
      createCodexHookService: createHookServiceFactory(),
    });

    await waitForAssertion(() => expect(hookInstaller.install).toHaveBeenCalledTimes(1));
    const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
    expect(events).toContain('"type":"hook.auto_repaired"');
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
      firstUserMessagePreview: '当前 resume 卡片列表信息量仍然很低',
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

    const recoveredSession = await store.getSession('sess_last');
    expect(recoveredSession).toMatchObject({
      status: 'interrupted',
      phase: 'interrupted',
      lastSummary: 'Interrupted during bot restart recovery.',
    });
    expect(recoveredSession?.lastActivityAt).toBe(recoveredSession?.updatedAt);
    expect(recoveredSession?.lastPhaseChangedAt).toBe(recoveredSession?.updatedAt);
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'resume', target: codexSessionId },
    });
    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBe(runner.starts[0].sessionId);
    const resumedSession = await store.getSession(runner.starts[0].sessionId);
    expect(resumedSession).toMatchObject({
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      phase: 'waiting_for_input',
      codexSessionId,
      resumedFromSessionId: 'sess_last',
      resumeSource: 'code_bot',
      firstUserMessagePreview: '当前 resume 卡片列表信息量仍然很低',
    });
    expect(resumedSession?.lastActivityAt).toBe(resumedSession?.updatedAt);
    expect(resumedSession?.lastPhaseChangedAt).toBe(resumedSession?.updatedAt);
  });

  it('auto-resumes an interrupted current session when it still has a Codex session id', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const codexSessionId = '019e8271-ddb8-7540-9baa-77ce58da1f26';
    await store.saveSession({
      id: 'sess_last',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'interrupted',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T09:09:20.569Z',
      updatedAt: '2026-06-01T09:19:01.493Z',
      logPath: store.sessionLogPath('sess_last'),
      codexSessionId,
      lastSummary: 'Failed to send to Codex: Codex session is not running: sess_last',
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

    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'resume', target: codexSessionId },
    });
    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBe(runner.starts[0].sessionId);
    const resumedSession = await store.getSession(runner.starts[0].sessionId);
    expect(resumedSession).toMatchObject({
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      phase: 'waiting_for_input',
      codexSessionId,
      resumedFromSessionId: 'sess_last',
      resumeSource: 'code_bot',
    });
    expect(resumedSession?.lastActivityAt).toBe(resumedSession?.updatedAt);
    expect(resumedSession?.lastPhaseChangedAt).toBe(resumedSession?.updatedAt);
  });

  it('discovers a missing Codex session id before auto-resuming startup recovery', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const codexSessionId = '019e8271-ddb8-7540-9baa-77ce58da1f26';
    const registry = {
      discoverForProject: vi.fn().mockResolvedValue({ ok: true, codexSessionId }),
    };
    await store.saveSession({
      id: 'sess_last',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T09:09:20.569Z',
      updatedAt: '2026-06-01T09:19:01.493Z',
      logPath: store.sessionLogPath('sess_last'),
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
      codexSessionRegistry: registry as any,
    } as any);

    await app.recoverStartupState();

    expect(registry.discoverForProject).toHaveBeenCalledWith({ projectPath: root, startedAt: '2026-06-01T09:09:20.569Z' });
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'resume', target: codexSessionId },
    });
    await expect(store.getSession('sess_last')).resolves.toMatchObject({
      status: 'interrupted',
      codexSessionId,
    });
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
    const notifier = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendRenderedMessage: vi.fn().mockResolvedValue(undefined),
      ...notifierTargetMethods,
    };
    const observationStore = new FakeCodexObservationStore();
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
      notifier,
      codexObservationStore: observationStore,
    });

    await app.recoverStartupState();
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'running',
      latestCommentary: '我先检查当前分支。',
      latestActivityAt: '2099-01-01T00:00:00.000Z',
      recentToolEvents: [],
    });
    await app.sessionManager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '当前分支是什么？' });
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '• 当前分支是：\nfeat/codex-completion-notifications',
      latestActivityAt: '2099-01-01T00:00:01.000Z',
      completedAt: '2099-01-01T00:00:01.000Z',
      recentToolEvents: [],
    });

    await runner.emitOutput(sessionId, 'trigger structured observation completion\n');

    await waitForAssertion(() => {
      expect(notifier.sendRenderedMessage).toHaveBeenCalledTimes(1);
    });
    await waitForAssertion(async () => {
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

  it('silently starts a new session for the only configured project when auto-resume fails', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const originalStart = runner.start.bind(runner);
    const codexSessionId = '019e8271-ddb8-7540-9baa-77ce58da1f26';
    const registry = {
      discoverForProject: vi.fn().mockResolvedValue({ ok: true, codexSessionId }),
    };
    let attempts = 0;
    runner.start = vi.fn(async (options) => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('resume failed');
      }
      await originalStart(options);
    });
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
      config: singleProjectConfig(root),
      store,
      codexRunner: runner,
      codexSessionRegistry: registry as any,
    } as any);

    await app.recoverStartupState();

    expect(runner.start).toHaveBeenCalledTimes(2);
    expect((runner.start as any).mock.calls[0][0]).toMatchObject({
      cwd: root,
      mode: { kind: 'resume', target: codexSessionId },
    });
    const failedResumeSessionId = (runner.start as any).mock.calls[0][0].sessionId;
    const failedResumeSession = await store.getSession(failedResumeSessionId);
    expect(failedResumeSession).toMatchObject({
      status: 'exited',
      phase: 'exited',
      lastSummary: `Failed to auto-resume Codex session ${codexSessionId}: resume failed`,
    });
    expect(failedResumeSession?.lastActivityAt).toBe(failedResumeSession?.updatedAt);
    expect(failedResumeSession?.lastPhaseChangedAt).toBe(failedResumeSession?.updatedAt);
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'new' },
    });
    const chat = await store.getChat('oc_1');
    expect(chat).toMatchObject({
      currentProjectId: 'repo',
      currentSessionId: runner.starts[0].sessionId,
    });
    const fallbackSession = await store.getSession(runner.starts[0].sessionId);
    expect(fallbackSession).toMatchObject({
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      phase: 'waiting_for_input',
      createdBy: 'ou_1',
    });
    expect(fallbackSession?.lastActivityAt).toBe(fallbackSession?.updatedAt);
    expect(fallbackSession?.lastPhaseChangedAt).toBe(fallbackSession?.updatedAt);
  });

  it('marks single-project fallback sessions exited when startup fails', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    runner.startError = new Error('fresh start failed');
    await store.saveSession({
      id: 'sess_last',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T09:09:20.569Z',
      updatedAt: '2026-06-01T09:19:01.493Z',
      logPath: store.sessionLogPath('sess_last'),
    });
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      currentSessionId: 'sess_last',
    });
    const app = createApp({
      projectRoot: root,
      config: singleProjectConfig(root),
      store,
      codexRunner: runner,
    });

    await app.recoverStartupState();

    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'new' },
    });
    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBeUndefined();
    const failedFallbackSession = await store.getSession(runner.starts[0].sessionId);
    expect(failedFallbackSession).toMatchObject({
      status: 'exited',
      phase: 'exited',
      lastSummary: 'Failed to auto-start single-project fallback session for repo: fresh start failed',
    });
    expect(failedFallbackSession?.lastActivityAt).toBe(failedFallbackSession?.updatedAt);
    expect(failedFallbackSession?.lastPhaseChangedAt).toBe(failedFallbackSession?.updatedAt);
  });

  it('does not silently start a new session when more than one project is configured', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    runner.startError = new Error('resume failed');
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
    });

    await app.recoverStartupState();

    expect(runner.starts).toHaveLength(1);
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBeUndefined();
    const failedSession = await store.getSession(runner.starts[0].sessionId);
    expect(failedSession).toMatchObject({
      status: 'exited',
      phase: 'exited',
      lastSummary: 'Failed to auto-resume Codex session 019e8271-ddb8-7540-9baa-77ce58da1f26: resume failed',
    });
    expect(failedSession?.lastActivityAt).toBe(failedSession?.updatedAt);
    expect(failedSession?.lastPhaseChangedAt).toBe(failedSession?.updatedAt);
  });
});
