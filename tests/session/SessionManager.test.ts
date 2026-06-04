import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { SessionManager } from '../../src/session/SessionManager.js';
import { createTmpDir } from '../helpers/tmp.js';
import { FakeCodexObservationStore, FakeCodexRunner, sampleConfig, sampleModelCatalog } from '../helpers/fakes.js';
import type { BotConfig, BotEvent, SessionRecord } from '../../src/domain/types.js';
import type { CodexRunOptions, CodexRunner } from '../../src/codex/CodexRunner.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

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

describe('SessionManager', () => {
  const singleProjectConfig = (root: string): BotConfig => {
    const config = sampleConfig(root);
    return { ...config, projects: [config.projects[0]] };
  };

  it('records discovered Codex session id after /new', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const registry = {
      discoverForProject: vi.fn().mockResolvedValue({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' }),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: { maxAttempts: 2, retryDelayMs: 0, sleep: async () => undefined },
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    await waitForAssertion(async () => {
      await expect(store.getSession(sessionId)).resolves.toMatchObject({
        codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
      });
    });
    expect(registry.discoverForProject).toHaveBeenCalledWith(expect.objectContaining({ projectPath: root }));
  });

  it('replies and saves chat before slow Codex session discovery finishes', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const discovery = deferred<{ ok: true; codexSessionId: string }>();
    const registry = {
      discoverForProject: vi.fn().mockReturnValue(discovery.promise),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: { maxAttempts: 2, retryDelayMs: 0, sleep: async () => undefined },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

    expect(result.reply).toContain('Created session');
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    const sessionId = chat?.currentSessionId;
    expect(sessionId).toBeDefined();
    await expect(store.getSession(sessionId!)).resolves.not.toHaveProperty('codexSessionId');
    expect(registry.discoverForProject).toHaveBeenCalledWith(expect.objectContaining({ projectPath: root }));

    discovery.resolve({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' });
    await waitForAssertion(async () => {
      await expect(store.getSession(sessionId!)).resolves.toMatchObject({
        codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
      });
    });
  });

  it('polls Codex session discovery until a delayed session file is found', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const sleeps: number[] = [];
    const registry = {
      discoverForProject: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: 'not-found' })
        .mockResolvedValueOnce({ ok: false, reason: 'not-found' })
        .mockResolvedValueOnce({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' }),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: {
        maxAttempts: 3,
        retryDelayMs: 25,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    await waitForAssertion(async () => {
      await expect(store.getSession(sessionId)).resolves.toMatchObject({
        codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
      });
    });
    expect(registry.discoverForProject).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([25, 25]);
  });

  it('timestamps Codex session discovery when the id is stored after a slow scan', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const storedCodexId = deferred<void>();
      class ObservingStore extends FileStateStore {
        async updateSession(sessionId: string, updater: (current: SessionRecord) => SessionRecord): Promise<SessionRecord | undefined> {
          const next = await super.updateSession(sessionId, updater);
          if (next?.codexSessionId) {
            storedCodexId.resolve();
          }
          return next;
        }
      }

      const store = new ObservingStore(root);
      const runner = new FakeCodexRunner();
      const discovery = deferred<{ ok: true; codexSessionId: string }>();
      const registry = {
        discoverForProject: vi.fn().mockReturnValue(discovery.promise),
      };
      const manager = new SessionManager(sampleConfig(root), store, runner, { codexSessionRegistry: registry as any });

      vi.setSystemTime(new Date('2026-06-01T00:00:00.000Z'));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

      vi.setSystemTime(new Date('2026-06-01T00:00:05.000Z'));
      await runner.exit(sessionId, 0);

      vi.setSystemTime(new Date('2026-06-01T00:00:10.000Z'));
      discovery.resolve({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' });
      await storedCodexId.promise;

      await expect(store.getSession(sessionId)).resolves.toMatchObject({
        status: 'exited',
        exitCode: 0,
        codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
        updatedAt: '2026-06-01T00:00:10.000Z',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves Codex session id when discovery interleaves with exit persistence', async () => {
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';
    class InterleavingStore extends FileStateStore {
      private injectedBeforeStaleExitSave = false;
      private injectedBeforeExitUpdate = false;

      async saveSession(session: SessionRecord): Promise<void> {
        if (session.status === 'exited' && !session.codexSessionId && !this.injectedBeforeStaleExitSave) {
          this.injectedBeforeStaleExitSave = true;
          await super.updateSession(session.id, (latest) => ({
            ...latest,
            codexSessionId,
            updatedAt: new Date().toISOString(),
          }));
        }
        await super.saveSession(session);
      }

      async updateSession(sessionId: string, updater: (current: SessionRecord) => SessionRecord): Promise<SessionRecord | undefined> {
        return super.updateSession(sessionId, (current) => {
          const next = updater(current);
          if (next.status === 'exited' && !current.codexSessionId && !this.injectedBeforeExitUpdate) {
            this.injectedBeforeExitUpdate = true;
            return updater({
              ...current,
              codexSessionId,
              updatedAt: new Date().toISOString(),
            });
          }
          return next;
        });
      }
    }

    const root = await createTmpDir();
    const store = new InterleavingStore(root);
    const runner = new FakeCodexRunner();
    const registry = {
      discoverForProject: vi.fn().mockReturnValue(new Promise(() => undefined)),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: { maxAttempts: 2, retryDelayMs: 0, sleep: async () => undefined },
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.exit(sessionId, 0);

    await expect(store.getSession(sessionId)).resolves.toMatchObject({
      status: 'exited',
      exitCode: 0,
      codexSessionId,
    });
  });

  it('replies and saves chat when Codex session discovery throws', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const registry = {
      discoverForProject: vi.fn().mockRejectedValue(new Error('registry unavailable')),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, { codexSessionRegistry: registry as any });

    const created = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

    expect(created.reply).toContain('Created session');
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    await waitForAssertion(async () => {
      const content = await readFile(eventPath, 'utf8');
      expect(content).toContain('"type":"session.codex_id_discovery_failed"');
      expect(content).toContain('"reason":"registry unavailable"');
      expect(content).toContain(`"sessionId":"${sessionId}"`);
    });
  });

  it.each(['not-found', 'ambiguous'] as const)('records Codex session discovery failure for %s', async (reason) => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const registry = {
      discoverForProject: vi.fn().mockResolvedValue({ ok: false, reason }),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: { maxAttempts: 2, retryDelayMs: 0, sleep: async () => undefined },
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);

    await waitForAssertion(async () => {
      const content = await readFile(eventPath, 'utf8');
      expect(content).toContain('"type":"session.codex_id_discovery_failed"');
      expect(content).toContain(`"reason":"${reason}"`);
      expect(content).toContain(`"sessionId":"${sessionId}"`);
    });
  });

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

  it('logs session creation summaries for explicit /new commands', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const logger = { info: vi.fn(), error: vi.fn() };
    const manager = new SessionManager(sampleConfig(root), store, runner, { logger });

    await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('session.created'));
  });

  it('auto-starts the only configured project for a first normal message with no active session', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(singleProjectConfig(root), store, runner);

    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      text: 'inspect status',
    });

    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'new' },
    });
    expect(runner.sentMessages).toEqual(['inspect status']);
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBe(runner.starts[0].sessionId);
    await expect(store.getSession(runner.starts[0].sessionId)).resolves.toMatchObject({
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
    });
    expect(sent.reply).toContain(`Sent to Codex session ${runner.starts[0].sessionId}.`);
  });

  it('logs single-project auto-start summaries for first normal messages', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const logger = { info: vi.fn(), error: vi.fn() };
    const manager = new SessionManager(singleProjectConfig(root), store, runner, { logger });

    await manager.handleText({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      text: 'inspect status',
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('session.auto_started_single_project'));
  });

  it('logs sanitized PTY output to the console in debug mode', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const logger = { info: vi.fn(), error: vi.fn() };
    const manager = new SessionManager(sampleConfig(root), store, runner, { logger, logLevel: 'debug' });

    await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });

    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.emitOutput(sessionId, '\u001b[32mhello from pty\u001b[0m\n');

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('session.pty'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('hello from pty'));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('\u001b[32m'));
  });

  it('does not log PTY output to the console outside debug mode', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const logger = { info: vi.fn(), error: vi.fn() };
    const manager = new SessionManager(sampleConfig(root), store, runner, { logger, logLevel: 'info' });

    await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/new repo',
    });

    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.emitOutput(sessionId, 'hello from pty\n');

    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('session.pty'));
  });

  it('keeps requiring explicit project selection for a first normal message when multiple projects exist', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      text: 'inspect status',
    });

    expect(sent.reply).toBe('No active session. Run /projects and /new <project> first.');
    expect(runner.starts).toHaveLength(0);
    expect(runner.sentMessages).toEqual([]);
    await expect(store.getChat('oc_1')).resolves.toBeUndefined();
  });

  it('returns the existing start failure reply when single-project auto-start cannot create a session', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    runner.startError = new Error('boot failed');
    const manager = new SessionManager(singleProjectConfig(root), store, runner);

    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      text: 'inspect status',
    });

    expect(sent.reply).toBe('Failed to start Codex for project repo: boot failed');
    expect(runner.sentMessages).toEqual([]);
    expect(runner.starts).toHaveLength(1);
    const [failedStart] = runner.starts;
    await expect(store.getChat('oc_1')).resolves.toBeUndefined();
    await expect(store.getSession(failedStart.sessionId)).resolves.toMatchObject({
      projectId: 'repo',
      status: 'exited',
      lastSummary: 'Failed to start Codex: boot failed',
    });
  });

  it('preserves send failure handling after single-project auto-start succeeds', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    runner.send = vi.fn(async () => {
      throw new Error('transport down');
    });
    const manager = new SessionManager(singleProjectConfig(root), store, runner);

    const sent = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      text: 'inspect status',
    });

    expect(runner.starts).toHaveLength(1);
    expect(runner.send).toHaveBeenCalledWith(runner.starts[0].sessionId, 'inspect status');
    expect(sent.reply).toBe('No running session. Run /new <project> first.');
    await expect(store.getSession(runner.starts[0].sessionId)).resolves.toMatchObject({
      status: 'interrupted',
      lastSummary: 'Failed to send to Codex: transport down',
    });
  });

  it('logs send failures to the console summary logger', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const logger = { info: vi.fn(), error: vi.fn() };
    runner.send = vi.fn(async () => {
      throw new Error('transport down');
    });
    const manager = new SessionManager(singleProjectConfig(root), store, runner, { logger });

    await manager.handleText({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      text: 'inspect status',
    });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('session.send_failed'));
  });

  it('returns an unconfirmed reply and retries submit once when processing is not confirmed in time', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendRenderedMessage: vi.fn().mockResolvedValue(undefined),
    };
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      notifier,
      codexObservationStore: observationStore,
      sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, sleep: async () => undefined },
    } as any);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3501';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

    const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });

    expect(sent.reply).toBe('');
    expect(runner.sentMessages).toEqual(['inspect status', '']);
    expect(notifier.sendText).not.toHaveBeenCalled();
  });

  it('stays silent for successful send acknowledgements in normal mode', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendRenderedMessage: vi.fn().mockResolvedValue(undefined),
    };
    const observationStore = new FakeCodexObservationStore();
    const config = sampleConfig(root);
    const manager = new SessionManager(config, store, runner, {
      notifier,
      codexObservationStore: observationStore,
      sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, sleep: async () => undefined },
    } as any);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3505';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'running',
      latestCommentary: '我先检查当前状态。',
      latestActivityAt: '2099-01-01T00:00:00.000Z',
      recentToolEvents: [],
    });

    const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });

    expect(sent.reply).toBe('');
    expect(runner.sentMessages).toEqual(['inspect status']);
  });

  it('acknowledges tasks only after observation confirms Codex started processing', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(sampleConfig(root), store, runner, {
        notifier,
        codexObservationStore: observationStore,
        sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, pollIntervalMs: 1 },
      } as any);

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3502';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

      const pendingReply = manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });
      await vi.advanceTimersByTimeAsync(1);
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'running',
        latestCommentary: '我先检查当前状态。',
        latestActivityAt: '2099-01-01T00:00:00.000Z',
        recentToolEvents: [],
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(pendingReply).resolves.toEqual({ reply: '' });
      expect(runner.sentMessages).toEqual(['inspect status']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps verbose send acknowledgements in debug mode', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const config = { ...sampleConfig(root), ui: { verbosity: 'debug' as const } };
      const manager = new SessionManager(config, store, runner, {
        notifier,
        codexObservationStore: observationStore,
        sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, pollIntervalMs: 1 },
      } as any);

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3506';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

      const pendingReply = manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });
      await vi.advanceTimersByTimeAsync(1);
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'running',
        latestCommentary: '我先检查当前状态。',
        latestActivityAt: '2099-01-01T00:00:00.000Z',
        recentToolEvents: [],
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(pendingReply).resolves.toMatchObject({
        reply: `已发送给 Codex，完成后我会主动通知你。\nsession: ${sessionId}`,
        renderedReply: expect.objectContaining({
          preferred: expect.objectContaining({ kind: 'card' }),
          fallback: expect.objectContaining({ kind: 'text' }),
        }),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat stale previous-turn observation activity as confirmation for a new send', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      notifier,
      codexObservationStore: observationStore,
      sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, sleep: async () => undefined },
    } as any);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3503';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'running',
      latestCommentary: '上一轮还在做事。',
      latestActivityAt: '2000-01-01T00:00:00.000Z',
      recentToolEvents: [],
    } as any);

    const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });

    expect(sent.reply).toBe('');
    expect(runner.sentMessages).toEqual(['inspect status', '']);
  });

  it('sends follow-up messages to an active Codex task instead of queueing them', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      notifier,
      codexObservationStore: observationStore,
      sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, sleep: async () => undefined },
    } as any);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3504';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first task' });
    const followUp = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '补充约束' });

    expect(followUp.reply).toBe('');
    expect(runner.sentMessages).toEqual(['first task', '', '补充约束']);
  });

  it('does not retry follow-up messages when observation stays silent', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(sampleConfig(root), store, runner, {
        notifier,
        codexObservationStore: observationStore,
        sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, pollIntervalMs: 1 },
      } as any);

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3514';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

      const firstReply = manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first task' });
      await vi.advanceTimersByTimeAsync(1);
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'running',
        latestCommentary: '我先处理 first task。',
        latestActivityAt: '2099-01-01T00:00:00.000Z',
        recentToolEvents: [],
      });
      await vi.advanceTimersByTimeAsync(1);
      await expect(firstReply).resolves.toEqual({ reply: '' });

      const followUp = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '补充约束' });

      expect(followUp.reply).toBe('');
      expect(runner.sentMessages).toEqual(['first task', '补充约束']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records send diagnostics before and after dispatching a normal task', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: { sendText: vi.fn() } });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });

    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"session.send_requested"');
    expect(content).toContain('"type":"session.send_dispatched"');
    expect(content).toContain(`"sessionId":"${sessionId}"`);
    expect(content).toContain('"textPreview":"inspect status"');
    expect(content).toContain('"transportTerminator":"\\\\r"');
  });

  it('does not treat PTY prompt echo as processing confirmation', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      notifier,
      codexObservationStore: observationStore,
      sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, sleep: async () => undefined },
    } as any);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3515';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
    const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '最近的一个 commit 做了什么事情？' });

    await runner.emitOutput(sessionId, '›最近的一个commit做了什么事情？\n');
    expect(sent.reply).toBe('');
    expect(runner.sentMessages).toEqual(['最近的一个 commit 做了什么事情？', '']);
  });

  it('acknowledges notified tasks when turn started event recording fails', async () => {
    class TurnStartedFailingStore extends FileStateStore {
      async appendEvent(event: BotEvent): Promise<void> {
        if (event.type === 'notification.turn_started') {
          throw new Error('event log unavailable');
        }
        await super.appendEvent(event);
      }
    }

    const root = await createTmpDir();
    const store = new TurnStartedFailingStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: { sendText: vi.fn() } });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    await expect(manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' })).resolves.toEqual({ reply: '' });
    expect(runner.sentMessages).toEqual(['inspect status']);
  });

  it('allows a second normal task while a pending notified turn is active', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: { sendText: vi.fn() } });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const first = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first task' });
    const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second task' });

    expect(first.reply).toBe('');
    expect(second.reply).toBe('');
    expect(runner.sentMessages).toEqual(['first task', 'second task']);
  });

  it('allows a second normal task when queue event recording fails', async () => {
    class QueueEventFailingStore extends FileStateStore {
      async appendEvent(event: BotEvent): Promise<void> {
        if (event.type === 'session.input_queued') {
          throw new Error('event log unavailable');
        }
        await super.appendEvent(event);
      }
    }

    const root = await createTmpDir();
    const store = new QueueEventFailingStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: { sendText: vi.fn() } });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first task' });

    await expect(manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second task' })).resolves.toEqual({ reply: '' });
    expect(runner.sentMessages).toEqual(['first task', 'second task']);
  });

  it('keeps /tail available while a pending notified turn is active', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: { sendText: vi.fn() } });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first task' });
    await runner.emitOutput(sessionId, 'partial output\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 10' });

    expect(tail.reply).toBe('partial output');
  });

  it('sends one proactive notification when final answer output stabilizes', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3401';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '当前分支是什么' });

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: '当前分支：develop',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, '• Working\n');
      await vi.advanceTimersByTimeAsync(49);
      expect(notifier.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
      expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '当前分支：develop');
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs notification delivery summaries after a completion is sent', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 20 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const logger = { info: vi.fn(), error: vi.fn() };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, logger, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3491';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '当前分支是什么' });

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: '当前分支：develop',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, '• Working\n');
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();

      await waitForAssertion(() => {
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('notification.sent'));
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs notification delivery failures when notifier sending fails', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 20 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockRejectedValue(new Error('notify failed')) };
      const logger = { info: vi.fn(), error: vi.fn() };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, logger, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3492';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '当前分支是什么' });

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: '当前分支：develop',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, '• Working\n');
      await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();

      await waitForAssertion(() => {
        expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('notification.failed'));
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for the latest changed answer candidate to stabilize before notifying', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3402';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'status' });

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'draft answer',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick 1\n');
      await vi.advanceTimersByTimeAsync(20);
      await runner.emitOutput(sessionId, '• Working\n');
      await vi.advanceTimersByTimeAsync(20);
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'final answer',
        completedAt: '2099-06-02T08:00:01.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick 2\n');

      await vi.advanceTimersByTimeAsync(10);
      expect(notifier.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(39);
      expect(notifier.sendText).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
      expect(notifier.sendText).toHaveBeenCalledWith('oc_1', 'final answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('records candidate diagnostics and the final selected answer for a stable completion', async () => {
    vi.useFakeTimers();
    try {
      class ObservingStore extends FileStateStore {
        readonly events: BotEvent[] = [];

        async appendEvent(event: BotEvent): Promise<void> {
          this.events.push(event);
          await super.appendEvent(event);
        }
      }

      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new ObservingStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3403';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'status' });

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'final answer',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick\n');
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();

      await waitForAssertion(() =>
        expect(store.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'notification.answer_candidate_updated',
              data: expect.objectContaining({
                sessionId,
                chatId: 'oc_1',
                candidatePreview: 'final answer',
                candidateHash: expect.any(String),
                source: 'observation',
                requireCompletionMarker: true,
              }),
            }),
            expect.objectContaining({
              type: 'notification.final_extract_selected',
              data: expect.objectContaining({
                sessionId,
                chatId: 'oc_1',
                projectId: 'repo',
                candidatePreview: 'final answer',
                candidateHash: expect.any(String),
                completionReason: 'stable',
                source: 'observation',
              }),
            }),
            expect.objectContaining({
              type: 'notification.turn_completed',
              data: expect.objectContaining({
                sessionId,
                chatId: 'oc_1',
                projectId: 'repo',
                extraction: 'answer',
                candidateUpdateCount: 1,
                completionReason: 'stable',
              }),
            }),
          ]),
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not complete from command transcript output before a final-answer divider', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3404';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'run tests' });

      await runner.emitOutput(sessionId, '• Ran npm test\n└ running test suite\nPASS tests/session/SessionManager.test.ts\n164 tests passed\n');
      await vi.advanceTimersByTimeAsync(100);
      expect(notifier.sendText).not.toHaveBeenCalled();

      const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second task' });
      expect(second.reply).toBe('');
      expect(runner.sentMessages).toEqual(['run tests', 'second task']);

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: '测试已通过，可以继续。',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick\n');
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();

      await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
      expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '测试已通过，可以继续。');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not complete from in-progress commentary before a final-answer divider', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const manager = new SessionManager(config, store, runner, { notifier });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '切换到最新的main分支' });

      await runner.emitOutput(sessionId, '• Working\n');
      await runner.emitOutput(sessionId, '• 我会先检查当前 git 状态和分支情况，确认是否有未提交改动，再安全地切到最新的 main。\n');
      await vi.advanceTimersByTimeAsync(100);
      expect(notifier.sendText).not.toHaveBeenCalled();

      const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '当前分支是什么' });
      expect(second.reply).toBe('');
      expect(runner.sentMessages).toEqual(['切换到最新的main分支', '当前分支是什么']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending completion timer when later command output invalidates the answer candidate', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3405';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'run tests' });

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'draft answer',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick 1\n');
      await vi.advanceTimersByTimeAsync(20);
      observationStore.snapshots.delete(codexSessionId);
      await runner.emitOutput(sessionId, '• Ran npm test\n└ running test suite\nPASS tests/session/SessionManager.test.ts\n');
      await vi.advanceTimersByTimeAsync(100);
      expect(notifier.sendText).not.toHaveBeenCalled();

      const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second task' });
      expect(second.reply).toBe('');

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: '测试已通过，可以继续。',
        completedAt: '2099-06-02T08:00:01.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick 2\n');
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();

      await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
      expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '测试已通过，可以继续。');
      expect(runner.sentMessages).toEqual(['run tests', 'second task']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not treat startup trust prompt output as turn progress or a final answer', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const manager = new SessionManager(config, store, runner, { notifier });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'hello' });

      await runner.emitOutput(
        sessionId,
        [
          '> You are in /data00/home/project',
          'Do you trust the contents of this directory?',
          '1. Yes, continue',
          '2. No, quit',
          'Press enter to continue',
        ].join('\n'),
      );

      await vi.advanceTimersByTimeAsync(300);
      expect(notifier.sendText).not.toHaveBeenCalled();

      const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '1' });
      expect(second.reply).toBe('');
      expect(runner.sentMessages).toEqual(['hello', '1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures first turn output even when previous log has no trailing newline', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      await store.appendSessionLog(sessionId, 'previous partial');
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3406';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'status' });
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'final answer',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick\n');
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();

      await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
      expect(notifier.sendText).toHaveBeenCalledWith('oc_1', 'final answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-reads the latest observation snapshot before sending stable completion', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3407';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'status' });

      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'stale answer',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick 1\n');
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'latest answer',
        completedAt: '2099-06-02T08:00:01.000Z',
        recentToolEvents: [],
      });
      await vi.advanceTimersByTimeAsync(50);
      vi.useRealTimers();

      await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
      expect(notifier.sendText).toHaveBeenCalledWith('oc_1', 'latest answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('prefers observation final answers over PTY extraction when completing a pending turn', async () => {
    class ObservingStore extends FileStateStore {
      readonly events: BotEvent[] = [];

      async appendEvent(event: BotEvent): Promise<void> {
        this.events.push(event);
        await super.appendEvent(event);
      }
    }

    const root = await createTmpDir();
    const store = new ObservingStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1, maxFinalChars: 40 } };
    const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a328b';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
    const longObservationAnswer =
      '结构化 final answer 优先于 PTY 提取，而且这段内容会被截断以保持通知长度与 PTY 提取一致。';
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: longObservationAnswer,
      completedAt: '2099-06-02T08:30:00.000Z',
      recentToolEvents: [],
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '继续实现 observation 方案' });
    await runner.emitOutput(sessionId, '这是 PTY 提取到的最终答案。\n');
    await runner.exit(sessionId, 0);

    await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
    expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '结构化 final answ…\n\n输出已截断，可使用 /tail 查看完整内容。');
    expect(store.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'notification.final_extract_selected',
          data: expect.objectContaining({
            sessionId,
            chatId: 'oc_1',
            projectId: 'repo',
            source: 'observation',
          }),
        }),
      ]),
    );
  });

  it('routes completion notifications through sendRenderedMessage when available', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendRenderedMessage: vi.fn().mockResolvedValue(undefined),
    };
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      notifier: notifier as any,
      codexObservationStore: observationStore,
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a4001';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'status' });

    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '**done**',
      completedAt: '2099-01-01T00:00:00.000Z',
      recentToolEvents: [],
    });

    await runner.emitOutput(sessionId, 'tick\n');

    await waitForAssertion(() => expect(notifier.sendRenderedMessage).toHaveBeenCalledTimes(1));
    expect(notifier.sendText).not.toHaveBeenCalled();
  });

  it('adds a rendered reply for ordinary synchronous responses', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/help' });

    expect(result.reply).toContain('/help');
    expect(result.renderedReply?.preferred.kind).toBe('card');
  });

  it('keeps tail responses on the text-only path', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await store.appendSessionLog(sessionId, 'hello\nworld\n');

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 10' });

    expect(result.reply).toContain('hello');
    expect(result.renderedReply).toBeUndefined();
  });

  it('does not fall back to PTY extraction when observation does not have a usable final answer', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
    const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a328c';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '   ',
      completedAt: '2026-06-02T08:31:00.000Z',
      recentToolEvents: [],
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '解释当前实现' });
    await runner.emitOutput(sessionId, '这是 PTY fallback 提取到的最终答案。\n');
    await runner.exit(sessionId, 0);

    await waitForAssertion(() =>
      expect(notifier.sendText).toHaveBeenCalledWith(
        'oc_1',
        `Codex 任务结束，但未能提取明确最终回答。\n\n原因：No structured final answer detected.\n可使用 /tail ${sessionId} 查看最近输出。`,
      ),
    );
  });

  it('does not let a stale previous-turn observation or PTY fallback override the current turn', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      vi.setSystemTime(new Date('2026-06-02T08:31:00.000Z'));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a328d';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'stale' },
        codexSessionId,
        status: 'completed',
        finalAnswer: '上一轮的 observation 最终答案。',
        completedAt: '2026-06-02T08:30:59.000Z',
        recentToolEvents: [],
      });

      vi.setSystemTime(new Date('2026-06-02T08:31:05.000Z'));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '解释当前实现' });
      await runner.emitOutput(sessionId, '这是当前轮次的 PTY 最终答案。\n');
      await runner.exit(sessionId, 0);

      vi.useRealTimers();
      await waitForAssertion(() =>
        expect(notifier.sendText).toHaveBeenCalledWith(
          'oc_1',
          `Codex 任务结束，但未能提取明确最终回答。\n\n原因：No structured final answer detected.\n可使用 /tail ${sessionId} 查看最近输出。`,
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to PTY final-answer extraction when codexSessionId cannot be discovered', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const registry = {
        discoverForProject: vi.fn().mockResolvedValue({ ok: false, reason: 'not-found' }),
      };
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
      const manager = new SessionManager(config, store, runner, {
        notifier,
        codexSessionRegistry: registry as any,
        codexSessionDiscovery: { maxAttempts: 1, retryDelayMs: 0, sleep: async () => undefined },
      });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '解释当前实现' });
      await runner.emitOutput(sessionId, '这是缺少 codexSessionId 时的 PTY 最终答案。\n');
      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();

      await waitForAssertion(() =>
        expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '这是缺少 codexSessionId 时的 PTY 最终答案。'),
      );
      expect(registry.discoverForProject).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a follow-up message trigger a second notification from stale observation state', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
    const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a328e';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first turn' });
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second turn' });
    const followUpAt = new Date().toISOString();

    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '这是第一轮的 observation 最终答案。',
      completedAt: '2099-06-02T08:00:00.000Z',
      recentToolEvents: [],
    });
    await runner.emitOutput(sessionId, 'tick 1\n');
    await waitForAssertion(() =>
      expect(notifier.sendText).toHaveBeenNthCalledWith(1, 'oc_1', '这是第一轮的 observation 最终答案。'),
    );

    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'stale' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '第一轮 observation 最终答案。',
      completedAt: followUpAt,
      recentToolEvents: [],
    });

    await runner.emitOutput(sessionId, 'tick 2\n');
    expect(notifier.sendText).toHaveBeenCalledTimes(1);

    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '这是第二轮的 observation 最终答案。',
      completedAt: '2099-06-02T08:00:01.000Z',
      recentToolEvents: [],
    });
    await runner.emitOutput(sessionId, 'tick 3\n');
    expect(notifier.sendText).toHaveBeenCalledTimes(1);
  });

  it('notifies on stable completion from a current-turn observation answer without a PTY final-answer candidate', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 10 } };
    const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3290';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '解释当前实现' });
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '这是当前轮次 observation 直接给出的最终答案。',
      completedAt: '2099-06-02T08:31:06.000Z',
      recentToolEvents: [],
    });

    await runner.emitOutput(sessionId, '正在整理最终答案...\n');

    await waitForAssertion(() =>
      expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '这是当前轮次 observation 直接给出的最终答案。'),
    );
    await expect(store.getSession(sessionId)).resolves.toMatchObject({ status: 'running' });
  });

  it('does not fall back to PTY extraction when observation lookup throws and still notifies', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    observationStore.readSnapshotError = new Error('observation unavailable');
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
    const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a328e';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '解释当前实现' });
    await runner.emitOutput(sessionId, '这是 observation 抛错后的 PTY 最终答案。\n');
    await runner.exit(sessionId, 0);

    await waitForAssertion(() =>
      expect(notifier.sendText).toHaveBeenCalledWith(
        'oc_1',
        `Codex 任务结束，但未能提取明确最终回答。\n\n原因：No structured final answer detected.\n可使用 /tail ${sessionId} 查看最近输出。`,
      ),
    );
  });

  it('discovers a delayed codexSessionId during completion and notifies from observation instead of PTY', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const observationStore = new FakeCodexObservationStore();
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3299';
    const registry = {
      discoverForProject: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: 'not-found' })
        .mockResolvedValueOnce({ ok: true, codexSessionId }),
    };
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
    const manager = new SessionManager(config, store, runner, {
      notifier,
      codexObservationStore: observationStore,
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: { maxAttempts: 1, retryDelayMs: 0, sleep: async () => undefined },
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '解释当前实现' });

    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '这是延迟发现 session id 后读到的 observation 最终答案。',
      completedAt: '2099-06-02T08:31:06.000Z',
      recentToolEvents: [],
    });

    await runner.emitOutput(sessionId, '这是不应该被用作最终答案的 PTY 内容。\n');
    await runner.exit(sessionId, 0);

    await waitForAssertion(() =>
      expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '这是延迟发现 session id 后读到的 observation 最终答案。'),
    );
    expect(registry.discoverForProject).toHaveBeenCalledTimes(2);
    await expect(store.getSession(sessionId)).resolves.toMatchObject({ codexSessionId });
  });

  it('allows a new task after the prior turn notification is sent', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3410';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first' });
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'first answer',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick\n');
      await vi.advanceTimersByTimeAsync(1);

      const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second' });
      expect(second.reply).toBe('');
      expect(runner.sentMessages).toEqual(['first', 'second']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a new task after stable notification sending fails', async () => {
    vi.useFakeTimers();
    try {
      class ObservingStore extends FileStateStore {
        readonly events: BotEvent[] = [];

        async appendEvent(event: BotEvent): Promise<void> {
          this.events.push(event);
          await super.appendEvent(event);
        }
      }

      const root = await createTmpDir();
      const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
      const store = new ObservingStore(root);
      const runner = new FakeCodexRunner();
      const notifier = { sendText: vi.fn().mockRejectedValueOnce(new Error('notify down')).mockResolvedValue(undefined) };
      const observationStore = new FakeCodexObservationStore();
      const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
      const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
      const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3412';
      await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
      await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first' });
      observationStore.snapshots.set(codexSessionId, {
        availability: { kind: 'ready' },
        codexSessionId,
        status: 'completed',
        finalAnswer: 'first answer',
        completedAt: '2099-06-02T08:00:00.000Z',
        recentToolEvents: [],
      });
      await runner.emitOutput(sessionId, 'tick\n');

      await vi.advanceTimersByTimeAsync(1);
      vi.useRealTimers();
      await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
      await waitForAssertion(() =>
        expect(store.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'notification.send_failed',
              data: expect.objectContaining({ sessionId, reason: 'notify down' }),
            }),
          ]),
        ),
      );

      const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second' });

      expect(second.reply).toBe('');
      expect(runner.sentMessages).toEqual(['first', 'second']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends an exit fallback notification for a pending turn', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = {
      sendText: vi.fn().mockResolvedValue(undefined),
      sendRenderedMessage: vi.fn().mockResolvedValue(undefined),
    };
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier, codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3413';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'summarize' });
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '最终结果',
      completedAt: '2099-06-02T08:00:00.000Z',
      recentToolEvents: [],
    });
    await runner.emitOutput(sessionId, 'tick\n');
    await runner.exit(sessionId, 0);

    expect(notifier.sendRenderedMessage).toHaveBeenCalledWith(
      'oc_1',
      expect.objectContaining({
        preferred: expect.objectContaining({ kind: 'card' }),
        fallback: expect.objectContaining({ kind: 'text', text: '最终结果' }),
      }),
    );
    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"notification.turn_exit_fallback"');
  });

  it('sends a failure-style fallback when exit has no final answer', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'summarize' });
    await runner.emitOutput(sessionId, '• Working\n');
    await runner.exit(sessionId, 1);

    expect(notifier.sendText).toHaveBeenCalledWith(
      'oc_1',
      `Codex 任务结束，但未能提取明确最终回答。\n\n原因：No structured final answer detected.\n可使用 /tail ${sessionId} 查看最近输出。`,
    );
  }, 10000);

  it('uses a failure fallback when exit only has in-progress commentary', async () => {
    class ObservingStore extends FileStateStore {
      readonly events: BotEvent[] = [];

      async appendEvent(event: BotEvent): Promise<void> {
        this.events.push(event);
        await super.appendEvent(event);
      }
    }

    const root = await createTmpDir();
    const store = new ObservingStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '切换到最新的main分支' });
    await runner.emitOutput(
      sessionId,
      '• Working\n• 我会先检查当前 git 状态和分支情况，确认是否有未提交改动，再安全地切到最新的 main。\n',
    );
    await runner.exit(sessionId, 1);

    expect(notifier.sendText).toHaveBeenCalledWith(
      'oc_1',
      `Codex 任务结束，但未能提取明确最终回答。\n\n原因：No structured final answer detected.\n可使用 /tail ${sessionId} 查看最近输出。`,
    );
    expect(store.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'notification.final_extract_empty',
          data: expect.objectContaining({
            sessionId,
            chatId: 'oc_1',
            projectId: 'repo',
            completionReason: 'exit',
            reason: 'No structured final answer detected.',
          }),
        }),
      ]),
    );
  });

  it('records notifier failures without throwing through exit handling', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockRejectedValue(new Error('feishu unavailable')) };
    const manager = new SessionManager(sampleConfig(root), store, runner, { notifier });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'summarize' });
    await runner.emitOutput(sessionId, '最终结果\n');
    await runner.exit(sessionId, 0);

    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"notification.send_failed"');
    expect(content).toContain('"reason":"feishu unavailable"');
  });

  it('uses legacy send reply when notifications are disabled', async () => {
    const root = await createTmpDir();
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, enabled: false } };
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(config, store, runner, { notifier: { sendText: vi.fn() } });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });

    expect(sent.reply).toBe(`Sent to Codex session ${sessionId}.`);
    expect(runner.sentMessages).toEqual(['inspect status']);
  });

  it('resumes from a code_bot session id with a known Codex id', async () => {
    const root = await createTmpDir();
    const repoPath = join(root, 'repo');
    const repo2Path = join(root, 'repo2');
    const config: BotConfig = {
      ...sampleConfig(root),
      projects: [
        { id: 'repo', name: 'Repo', path: repoPath, codexArgs: [] },
        { id: 'repo2', name: 'Repo 2', path: repo2Path, codexArgs: [] },
      ],
    };
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(config, store, runner);
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';
    const oldSessionId = 'sess_old';
    const oldSession: SessionRecord = {
      id: oldSessionId,
      chatId: 'oc_1',
      projectId: 'repo2',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(oldSessionId),
      codexSessionId,
    };
    await store.saveSession(oldSession);
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: oldSessionId });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/resume ${oldSessionId}` });

    expect(resumed.reply).toContain('Resumed session');
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0].mode).toEqual({ kind: 'resume', target: codexSessionId });
    expect(runner.starts[0].cwd).toBe(repo2Path);
    expect(runner.sentMessages).toEqual([]);
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo2');
    expect(chat?.currentSessionId).toBe(runner.starts[0].sessionId);
    await expect(store.getSession(runner.starts[0].sessionId)).resolves.toMatchObject({
      chatId: 'oc_1',
      projectId: 'repo2',
      status: 'running',
      resumedFromSessionId: oldSessionId,
      resumeSource: 'code_bot',
    });
  });

  it('discovers a missing Codex session id before resuming a code_bot session id', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';
    const registry = {
      discoverForProject: vi.fn().mockResolvedValue({ ok: true, codexSessionId }),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: { maxAttempts: 1, retryDelayMs: 0, sleep: async () => undefined },
    });
    const oldSessionId = 'sess_old';
    await store.saveSession({
      id: oldSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'interrupted',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T09:09:20.569Z',
      updatedAt: '2026-06-01T09:19:01.493Z',
      logPath: store.sessionLogPath(oldSessionId),
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/resume ${oldSessionId}` });

    expect(resumed.reply).toContain('Resumed session');
    expect(registry.discoverForProject).toHaveBeenCalledWith({ projectPath: root, startedAt: '2026-06-01T09:09:20.569Z' });
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0].mode).toEqual({ kind: 'resume', target: codexSessionId });
    await expect(store.getSession(oldSessionId)).resolves.toMatchObject({ codexSessionId });
    await expect(store.getSession(runner.starts[0].sessionId)).resolves.toMatchObject({
      codexSessionId,
      resumedFromSessionId: oldSessionId,
      resumeSource: 'code_bot',
    });
  });

  it('resumes from a Codex native id and explicit project', async () => {
    const root = await createTmpDir();
    const repoPath = join(root, 'repo');
    const repo2Path = join(root, 'repo2');
    const config: BotConfig = {
      ...sampleConfig(root),
      projects: [
        { id: 'repo', name: 'Repo', path: repoPath, codexArgs: ['--model', 'gpt-5'] },
        { id: 'repo2', name: 'Repo 2', path: repo2Path, codexArgs: ['--model', 'gpt-5-mini'] },
      ],
    };
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(config, store, runner);
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/resume ${codexSessionId} repo2` });

    expect(resumed.reply).toContain('Resumed session');
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: repo2Path,
      args: ['--model', 'gpt-5-mini'],
      mode: { kind: 'resume', target: codexSessionId },
    });
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo2');
    expect(chat?.currentSessionId).toBe(runner.starts[0].sessionId);
    await expect(store.getSession(runner.starts[0].sessionId)).resolves.toMatchObject({
      chatId: 'oc_1',
      projectId: 'repo2',
      status: 'running',
      codexSessionId,
      resumeSource: 'codex',
    });
  });

  it('does not treat an unknown code_bot session id as a native Codex id', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume sess_missing' });

    expect(resumed.reply).toBe('Session not found: sess_missing');
    expect(runner.starts).toHaveLength(0);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBeUndefined();
  });

  it('returns usage and keeps current session when /resume has no target', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const priorSessionId = 'sess_prior';
    await store.saveSession({
      id: priorSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(priorSessionId),
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: priorSessionId });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume' });

    expect(resumed.reply).toBe('Usage: /resume <session> [project]');
    expect(runner.starts).toHaveLength(0);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBe(priorSessionId);
  });

  it('rejects /resume while the current session is running', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const first = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    expect(first.reply).toContain('Created session');
    const originalSessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const resumed = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/resume 019e7f20-a667-7632-a808-c9595d77116e repo',
    });

    expect(resumed.reply).toBe(`Current session ${originalSessionId} is still running. Run /stop before resuming another session.`);
    expect(runner.starts).toHaveLength(1);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBe(originalSessionId);
  });

  it('rejects /resume while the current session is starting', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const startingSessionId = 'sess_starting';
    await store.saveSession({
      id: startingSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'starting',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(startingSessionId),
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: startingSessionId });

    const resumed = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/resume 019e7f20-a667-7632-a808-c9595d77116e repo',
    });

    expect(resumed.reply).toBe(`Current session ${startingSessionId} is still running. Run /stop before resuming another session.`);
    expect(runner.starts).toHaveLength(0);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBe(startingSessionId);
  });

  it('rejects native Codex id resume without an explicit or current project', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    const resumed = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/resume 019e7f20-a667-7632-a808-c9595d77116e',
    });

    expect(resumed.reply).toBe('Choose a project with /projects and /resume <codex-session-id> <project>.');
    expect(runner.starts).toHaveLength(0);
    expect(await store.getChat('oc_1')).toBeUndefined();
  });

  it('auto-selects the only configured project for /resume with a native Codex id', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const config = sampleConfig(root);
    config.projects = [config.projects[0]!];
    const manager = new SessionManager(config, store, runner);
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';

    const resumed = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: `/resume ${codexSessionId}`,
    });

    expect(resumed.reply).toContain(`Resumed session`);
    expect(resumed.reply).toContain(`project ${config.projects[0]!.id}`);
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'resume', target: codexSessionId },
    });
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe(config.projects[0]!.id);
    expect(chat?.currentSessionId).toBeTruthy();
  });

  it('rejects malformed native Codex id resume without starting a runner', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const priorSessionId = 'sess_prior';
    await store.saveSession({
      id: priorSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(priorSessionId),
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: priorSessionId });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume ../x repo' });

    expect(resumed.reply).toBe('Invalid session target: ../x');
    expect(runner.starts).toHaveLength(0);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBe(priorSessionId);
  });

  it.each(['--last', '-x'])('rejects option-looking native Codex id resume target %s', async (target) => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const priorSessionId = 'sess_prior';
    await store.saveSession({
      id: priorSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(priorSessionId),
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: priorSessionId });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/resume ${target} repo` });

    expect(resumed.reply).toBe(`Invalid session target: ${target}`);
    expect(runner.starts).toHaveLength(0);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBe(priorSessionId);
  });

  it('rejects code_bot session resume when the source session belongs to another chat', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    await store.saveSession({
      id: 'sess_other',
      chatId: 'oc_other',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_other',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath('sess_other'),
      codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume sess_other' });

    expect(resumed.reply).toBe('Session not found: sess_other');
    expect(runner.starts).toHaveLength(0);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBeUndefined();
  });

  it('rejects code_bot session resume when no Codex session id was captured', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const registry = {
      discoverForProject: vi.fn().mockResolvedValue({ ok: false, reason: 'not-found' }),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: { maxAttempts: 1, retryDelayMs: 0, sleep: async () => undefined },
    });
    await store.saveSession({
      id: 'sess_old',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath('sess_old'),
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/resume sess_old' });

    expect(resumed.reply).toBe('Session sess_old cannot be resumed because no Codex session id was captured.');
    expect(registry.discoverForProject).toHaveBeenCalledWith(expect.objectContaining({ projectPath: root }));
    expect(runner.starts).toHaveLength(0);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBeUndefined();
  });

  it('rejects native Codex id resume when the stored session belongs to another chat', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';
    const priorSessionId = 'sess_prior';
    await store.saveSession({
      id: priorSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(priorSessionId),
    });
    await store.saveSession({
      id: 'sess_other',
      chatId: 'oc_other',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_other',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath('sess_other'),
      codexSessionId,
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: priorSessionId });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/resume ${codexSessionId}` });

    expect(resumed.reply).toBe(`Session not found: ${codexSessionId}`);
    expect(runner.starts).toHaveLength(0);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBe(priorSessionId);
  });

  it('rejects native Codex id resume when the current project differs from the stored session project', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';
    await store.saveSession({
      id: 'sess_old',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath('sess_old'),
      codexSessionId,
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo2' });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/resume ${codexSessionId}` });

    expect(resumed.reply).toBe('Project repo2 does not match session sess_old project repo.');
    expect(runner.starts).toHaveLength(0);
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo2');
    expect(chat?.currentSessionId).toBeUndefined();
  });

  it('does not switch current session when resume runner start fails', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const priorSessionId = 'sess_prior';
    await store.saveSession({
      id: priorSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(priorSessionId),
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: priorSessionId });
    runner.startError = new Error('spawn failed');

    const resumed = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/resume 019e7f20-a667-7632-a808-c9595d77116e',
    });

    expect(resumed.reply).toBe('Failed to resume Codex session 019e7f20-a667-7632-a808-c9595d77116e for project repo: spawn failed');
    expect((await store.getChat('oc_1'))?.currentSessionId).toBe(priorSessionId);
  });

  it('rejects code_bot session resume when an explicit project differs from the source session project', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const oldSessionId = 'sess_old';
    await store.saveSession({
      id: oldSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(oldSessionId),
      codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e',
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo2' });

    const resumed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/resume ${oldSessionId} repo2` });

    expect(resumed.reply).toBe(`Project repo2 does not match session ${oldSessionId} project repo.`);
    expect(runner.starts).toHaveLength(0);
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo2');
    expect(chat?.currentSessionId).toBeUndefined();
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

  it('auto-stops the current session before /new repo2', async () => {
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
    expect(second.reply).toContain(`Stopped session ${originalSessionId}.`);
    expect(second.reply).toContain('Created session');

    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo2');
    expect(chat?.currentSessionId).toBeDefined();
    expect(chat?.currentSessionId).not.toBe(originalSessionId);
    await expect(store.getSession(originalSessionId)).resolves.toMatchObject({
      status: 'interrupted',
      stopRequested: true,
    });
    expect(runner.starts).toHaveLength(2);
  });

  it('auto-stops the current session before /new repo', async () => {
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
    expect(second.reply).toContain(`Stopped session ${originalSessionId}.`);
    expect(second.reply).toContain('Created session');

    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBeDefined();
    expect(chat?.currentSessionId).not.toBe(originalSessionId);
    await expect(store.getSession(originalSessionId)).resolves.toMatchObject({
      status: 'interrupted',
      stopRequested: true,
    });
    expect(runner.starts).toHaveLength(2);
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

    expect(first.reply).toContain('Created session');
    expect(second.reply).toContain('Stopped session');
    expect(second.reply).toContain('Created session');
    expect(runner.starts).toHaveLength(2);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBe(runner.starts[1].sessionId);
    await expect(store.getSession(runner.starts[0].sessionId)).resolves.toMatchObject({
      status: 'interrupted',
      stopRequested: true,
    });
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
    expect(content).toContain('"type":"session.send_requested"');
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

    await expect(manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo' })).resolves.toMatchObject({
      reply: 'Current project set to repo.',
      renderedReply: expect.objectContaining({
        preferred: expect.objectContaining({ kind: 'card' }),
      }),
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await runner.emitOutput(sessionId, 'ready\n');

    const status = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });
    expect(status.reply).toContain('Project: repo');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 10' });
    expect(tail.reply).toBe('ready');
  });

  it('auto-selects the only configured project for /new', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const config = sampleConfig(root);
    config.projects = [config.projects[0]!];
    const manager = new SessionManager(config, store, runner);

    const created = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new' });

    expect(created.reply).toContain(`Created session`);
    expect(created.reply).toContain(`project ${config.projects[0]!.id}`);
    expect(runner.starts).toHaveLength(1);
    expect(runner.starts[0]).toMatchObject({
      cwd: root,
      mode: { kind: 'new' },
    });
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe(config.projects[0]!.id);
    expect(chat?.currentSessionId).toBeTruthy();
  });

  it('supports commands prefixed by a group mention', async () => {
    const root = await createTmpDir();
    const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

    const projects = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '@_user_1 /projects',
      wasMentioned: true,
    });

    expect(projects.reply).toContain('repo: Repo');
    expect(projects.reply).toContain('repo2: Repo 2');
  });

  it('silently ignores unmentioned group commands', async () => {
    const root = await createTmpDir();
    const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

    const result = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/projects',
      wasMentioned: false,
    });

    expect(result).toEqual({ reply: '' });
  });

  it('silently ignores unmentioned group messages even when a session is active', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo', wasMentioned: true });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const result = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'hello',
      wasMentioned: false,
    });

    expect(result).toEqual({ reply: '' });
    expect(runner.sentMessages).toEqual([]);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBe(sessionId);
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
    expect(help.reply).toContain('/resume <session> [project]');
    expect(help.reply).toContain('/tail [n]');
    expect(help.reply).toContain('/rawtail [n]');
    expect(help.reply).toContain('Resume: /resume <session> [project]');
    expect(help.reply).toContain('session can be a code_bot session id from /sessions or a Codex native id');
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

  it('includes live Codex status details in /status for a running session', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    runner.version = '0.136.0';
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexStatus: { liveFetchTimeoutMs: 100, quietMs: 0 },
      codexObservationStore: observationStore,
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const session = (await store.getSession(sessionId))!;
    await store.saveSession({ ...session, codexSessionId: 'codex_1' });
    observationStore.snapshots.set('codex_1', {
      availability: { kind: 'ready' },
      codexSessionId: 'codex_1',
      status: 'running',
      cwd: root,
      cliVersion: '0.135.0',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      summaryMode: 'auto',
      permissions: 'Full Access',
      collaborationMode: 'default',
      latestActivityAt: '2026-06-03T08:00:00.000Z',
      tokenCount: {
        total: { inputTokens: 1000, cachedInputTokens: 700, outputTokens: 100, reasoningOutputTokens: 20, totalTokens: 1100 },
        last: { inputTokens: 200, cachedInputTokens: 100, outputTokens: 20, reasoningOutputTokens: 5, totalTokens: 220 },
        modelContextWindow: 4096,
      },
      rateLimits: {
        primary: { usedPercent: 14, windowMinutes: 300, resetsAt: '2026-06-03T08:30:00.000Z' },
        secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: '2026-06-10T08:30:00.000Z' },
        planType: 'prolite',
      },
      recentToolEvents: [],
    });
    runner.queueStatusResponse(sessionId, 'status\r\nStatus: running\r\nTask: Implement status integration\r\nModel: gpt-5-codex\r\n');

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });

    expect(result.reply).toContain('Project: repo');
    expect(result.reply).toContain('Codex');
    expect(result.reply).toContain('Source: live');
    expect(result.reply).toContain('Status line: running');
    expect(result.reply).toContain('Task: Implement status integration');
    expect(result.reply).toContain('CLI version: 0.135.0');
    expect(result.reply).toContain('Installed CLI version: 0.136.0');
    expect(result.reply).toContain('Reasoning: medium');
    expect(result.reply).toContain('Summaries: auto');
    expect(result.reply).toContain('Permissions: Full Access');
    expect(result.reply).toContain('Collaboration mode: default');
    expect(result.reply).toContain('5h limit: 86% left');
    expect(result.reply).toContain('Weekly limit: 90% left');
    expect(result.reply).toContain('Plan type: Prolite');
    await expect(store.getSession(sessionId)).resolves.toMatchObject({
      codexStatus: {
        source: 'live',
        summary: {
          statusLine: 'running',
          currentTask: 'Implement status integration',
          model: 'gpt-5-codex',
        },
      },
    });
  });

  it('lists model catalog entries with current model and saved default model', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexStatus: { liveFetchTimeoutMs: 100, quietMs: 0 },
      codexObservationStore: observationStore,
      modelCatalog: { read: async () => sampleModelCatalog },
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const chat = (await store.getChat('oc_1'))!;
    const sessionId = chat.currentSessionId!;
    const session = (await store.getSession(sessionId))!;
    await store.saveSession({ ...session, codexSessionId: 'codex_1' });
    await store.saveChat({
      ...chat,
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5-mini',
          reasoningEffort: 'low',
          updatedAt: '2026-06-03T10:00:00.000Z',
        },
      },
    });
    observationStore.snapshots.set('codex_1', {
      availability: { kind: 'ready' },
      codexSessionId: 'codex_1',
      status: 'running',
      model: 'gpt-5.5',
      reasoningEffort: 'high',
      latestActivityAt: '2026-06-03T08:00:00.000Z',
      recentToolEvents: [],
    });
    runner.queueStatusResponse(sessionId, 'status\r\nStatus: running\r\nModel: gpt-5.5\r\n');

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model' });

    expect(result.reply).toContain('Codex models');
    expect(result.reply).toContain('Client: 0.136.0');
    expect(result.reply).toContain('Fetched: 2026-06-03T13:43:32.128077Z');
    expect(result.reply).toContain('Current: gpt-5.5');
    expect(result.reply).toContain('Reasoning: high');
    expect(result.reply).toContain('Saved default: gpt-5.5-mini');
    expect(result.reply).toContain('Saved reasoning: low');
    expect(result.reply).toContain('- gpt-5.5 (GPT 5.5)');
    expect(result.reply).toContain('default reasoning: medium');
    expect(result.reply).toContain('supported reasoning: low, medium, high');
    expect(result.reply).toContain('- gpt-5.5-mini (GPT 5.5 Mini)');
    expect(result.reply.indexOf('- gpt-5.5 (GPT 5.5)')).toBeLessThan(result.reply.indexOf('- gpt-5.5-mini (GPT 5.5 Mini)'));
  });

  it('rejects unknown model and lists available models', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model unknown' });

    expect(result.reply).toContain('Unknown model: unknown');
    expect(result.reply).toContain('Available models: gpt-5.5, gpt-5.5-mini');
  });

  it('rejects unsupported model reasoning level and lists supported reasoning levels', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5 turbo' });

    expect(result.reply).toContain('Unsupported reasoning level: turbo');
    expect(result.reply).toContain('Supported reasoning levels: low, medium, high');
  });

  it('returns model usage for too many args', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5 high extra' });

    expect(result.reply).toBe('Usage: /model [model] [reasoning]');
  });

  it('saves model selection without running session', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const store = new FileStateStore(root);
      const runner = new FakeCodexRunner();
      const manager = new SessionManager(sampleConfig(root), store, runner, {
        modelCatalog: { read: async () => sampleModelCatalog },
      });
      await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });
      vi.setSystemTime(new Date('2026-06-04T01:02:03.000Z'));

      const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5 high' });

      expect(result.reply).toContain('Saved default model: gpt-5.5 high');
      expect(result.reply).toContain('No running Codex session. The next /new or /resume will use this model.');
      expect(runner.sentMessages).toEqual([]);
      await expect(store.getChat('oc_1')).resolves.toMatchObject({
        modelSelectionsByProject: {
          repo: {
            model: 'gpt-5.5',
            reasoningEffort: 'high',
            updatedAt: '2026-06-04T01:02:03.000Z',
          },
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves saved model selection when new session updates chat', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          updatedAt: '2026-06-04T01:02:03.000Z',
        },
      },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

    expect(result.reply).toContain('Created session');
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBe(runner.starts[0].sessionId);
    expect(chat?.modelSelectionsByProject).toEqual({
      repo: {
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        updatedAt: '2026-06-04T01:02:03.000Z',
      },
    });
  });

  it('applies saved model selection when starting a new session and preserves project args without mutation', async () => {
    const root = await createTmpDir();
    const projectArgs = [
      '--search',
      '--model',
      'gpt-5',
      '-m=gpt-5-mini',
      '-c',
      'model="gpt-5"',
      '--config',
      'model="gpt-5"',
      '-c',
      'model_reasoning_effort="low"',
      '--config=model="gpt-5"',
      '-c=model="gpt-5"',
      '-cmodel="gpt-5"',
      '--config=model_reasoning_effort="low"',
      '-c=model_reasoning_effort="low"',
      '-cmodel_reasoning_effort="low"',
      '-c',
      'sandbox_mode=workspace-write',
      '--config',
      'shell_environment_policy.inherit=all',
      '--config=sandbox_mode="workspace-write"',
      '-c=shell_environment_policy.inherit=all',
      '-csandbox_mode=read-only',
    ];
    const config: BotConfig = {
      ...sampleConfig(root),
      projects: [{ id: 'repo', name: 'Repo', path: root, codexArgs: projectArgs }],
    };
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(config, store, runner);
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          updatedAt: '2026-06-04T01:02:03.000Z',
        },
      },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

    expect(result.reply).toContain('Created session');
    expect(runner.starts[0].args).toEqual([
      '--search',
      '-c',
      'sandbox_mode=workspace-write',
      '--config',
      'shell_environment_policy.inherit=all',
      '--config=sandbox_mode="workspace-write"',
      '-c=shell_environment_policy.inherit=all',
      '-csandbox_mode=read-only',
      '--model',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort="high"',
    ]);
    expect(config.projects[0]!.codexArgs).toEqual(projectArgs);
  });

  it('applies saved model selection when resuming a native Codex session and overrides project shorthand model args', async () => {
    const root = await createTmpDir();
    const config: BotConfig = {
      ...sampleConfig(root),
      projects: [{ id: 'repo', name: 'Repo', path: root, codexArgs: ['-m', 'gpt-5', '--search'] }],
    };
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(config, store, runner);
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5-mini',
          updatedAt: '2026-06-04T01:02:03.000Z',
        },
      },
    });

    const result = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: `/resume ${codexSessionId}`,
    });

    expect(result.reply).toContain('Resumed session');
    expect(runner.starts[0]).toMatchObject({
      args: ['--search', '--model', 'gpt-5.5-mini'],
      mode: { kind: 'resume', target: codexSessionId },
    });
    expect(config.projects[0]!.codexArgs).toEqual(['-m', 'gpt-5', '--search']);
  });

  it('preserves saved model selection when /use updates chat', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          updatedAt: '2026-06-04T01:02:03.000Z',
        },
      },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo2' });

    expect(result.reply).toBe('Current project set to repo2.');
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo2');
    expect(chat?.currentSessionId).toBeUndefined();
    expect(chat?.modelSelectionsByProject).toEqual({
      repo: {
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        updatedAt: '2026-06-04T01:02:03.000Z',
      },
    });
  });

  it('preserves saved model selection when /stop updates chat', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const chatBeforeStop = (await store.getChat('oc_1'))!;
    await store.saveChat({
      ...chatBeforeStop,
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          updatedAt: '2026-06-04T01:02:03.000Z',
        },
      },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });

    expect(result.reply).toBe(`Stopped session ${chatBeforeStop.currentSessionId}.`);
    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBeUndefined();
    expect(chat?.modelSelectionsByProject).toEqual({
      repo: {
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        updatedAt: '2026-06-04T01:02:03.000Z',
      },
    });
  });

  it('saves model selection and sends runtime switch to running session', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5 high' });

    expect(result.reply).toContain('Saved default model: gpt-5.5 high');
    expect(result.reply).toContain('Sent runtime switch to current Codex session. Use /status to confirm the observed model.');
    expect(runner.sentMessages).toEqual(['/model gpt-5.5 high']);
    await expect(store.getChat('oc_1')).resolves.toMatchObject({
      currentSessionId: sessionId,
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          updatedAt: expect.any(String),
        },
      },
    });
  });

  it('requires selected project before saving model selection', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5 high' });

    expect(result.reply).toBe('No project selected. Run /use <project> or /new <project> first.');
    expect(await store.getChat('oc_1')).toBeUndefined();
    expect(runner.sentMessages).toEqual([]);
  });

  it('keeps saved default when runtime switch fails', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      modelCatalog: { read: async () => sampleModelCatalog },
    });
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    runner.dropSession(sessionId);

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5-mini' });

    expect(result.reply).toContain('Saved default model: gpt-5.5-mini');
    expect(result.reply).toContain(`Runtime switch failed: Unknown fake session: ${sessionId}`);
    await expect(store.getChat('oc_1')).resolves.toMatchObject({
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5-mini',
          updatedAt: expect.any(String),
        },
      },
    });
    expect((await store.getChat('oc_1'))?.modelSelectionsByProject?.repo.reasoningEffort).toBeUndefined();
  });

  it('returns a custom rendered markdown reply for /status', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexStatus: { liveFetchTimeoutMs: 100, quietMs: 0 },
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    runner.queueStatusResponse(sessionId, 'status\r\nStatus: running\r\nTask: Implement status integration\r\n');

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });

    expect(result.renderedReply?.preferred.kind).toBe('card');
    if (result.renderedReply?.preferred.kind !== 'card') {
      throw new Error('expected a card payload');
    }
    const payload = JSON.stringify(result.renderedReply.preferred.payload);
    expect(payload).toContain('## Session');
    expect(payload).toContain('## Codex');
    expect(payload).not.toContain('## Raw');
    expect(payload).toContain('- **Status**: `running`');
    expect(payload).toContain('- **Source**: `live`');
    expect(result.reply).toContain('Project: repo');
    expect(result.reply).toContain('Task: Implement status integration');
  });

  it('uses cached Codex status for an exited session without sending a new request', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const session = (await store.getSession(sessionId))!;
    await store.saveSession({
      ...session,
      status: 'exited',
      codexStatus: {
        source: 'live',
        fetchedAt: '2026-06-03T08:00:00.000Z',
        rawText: 'Status: completed',
        summary: { statusLine: 'completed' },
      },
    });

    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });

    expect(result.reply).not.toContain('Summary:');
    expect(result.reply).not.toContain('Pending approvals:');
    expect(result.reply).toContain('Source: cached');
    expect(result.reply).toContain('Status line: completed');
    expect(runner.sentMessages).not.toContain('status');
  });

  it('keeps running session current and stoppable when /use targets another project', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    const created = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    expect(created.reply).toContain('Created session');
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const switched = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/use repo2' });
    expect(switched.reply).toBe(`Current session ${sessionId} is still running. Run /stop before switching projects.`);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentProjectId).toBe('repo');
    expect(chat?.currentSessionId).toBe(sessionId);

    const stopped = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    expect(stopped.reply).toBe(`Stopped session ${sessionId}.`);
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

    expect(tail.reply).not.toContain('```text');
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

  it('uses sanitized PTY output for /tail even when a structured snapshot is available', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, { codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId: '019e86b4-12ed-7731-9639-c128626a328b' }));
    observationStore.snapshots.set('019e86b4-12ed-7731-9639-c128626a328b', {
      availability: { kind: 'ready' },
      codexSessionId: '019e86b4-12ed-7731-9639-c128626a328b',
      status: 'running',
      latestCommentary: '我先看当前 tail 逻辑，再切 observation。',
      recentToolEvents: [
        {
          kind: 'tool_call',
          toolName: 'exec_command',
          summary: "exec_command: sed -n '1,80p' src/session/SessionManager.ts",
          at: '2026-06-02T08:20:00.000Z',
        },
      ],
    });
    await runner.emitOutput(sessionId, 'raw terminal output should be used\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

    expect(tail.reply).toContain('raw terminal output should be used');
    expect(tail.reply).not.toContain('Status: running');
    expect(tail.reply).not.toContain('我先看当前 tail 逻辑，再切 observation。');
  });

  it('falls back to sanitized PTY output when observation is unavailable', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, { codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId: '019e86b4-12ed-7731-9639-c128626a328c' }));
    await runner.emitOutput(sessionId, '⚠ MCP startup incomplete (failed: figma)\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

    expect(tail.reply).toContain('⚠ MCP startup incomplete (failed: figma)');
  });

  it('falls back to sanitized PTY output when observation is not yet flushed', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, { codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId: '019e86b4-12ed-7731-9639-c128626a3280' }));
    observationStore.snapshots.set('019e86b4-12ed-7731-9639-c128626a3280', {
      availability: { kind: 'not_yet_flushed' },
      codexSessionId: '019e86b4-12ed-7731-9639-c128626a3280',
      status: 'unknown',
      recentToolEvents: [],
    });
    await runner.emitOutput(sessionId, 'PTY fallback while observation has only session_meta\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

    expect(tail.reply).toContain('PTY fallback while observation has only session_meta');
    expect(tail.reply).not.toContain('Status: unknown');
  });

  it('keeps /tail count validation when observation is available', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, { codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId: '019e86b4-12ed-7731-9639-c128626a328d' }));
    observationStore.snapshots.set('019e86b4-12ed-7731-9639-c128626a328d', {
      availability: { kind: 'ready' },
      codexSessionId: '019e86b4-12ed-7731-9639-c128626a328d',
      status: 'running',
      latestCommentary: 'structured progress',
      recentToolEvents: [],
    });

    for (const value of ['10abc', '1e3', '0', '-1']) {
      const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/tail ${value}` });
      expect(result.reply).toBe('Invalid tail count.');
    }
  });

  it('falls back to sanitized PTY output when observation lookup throws', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    observationStore.readSnapshotError = new Error('observation unavailable');
    const manager = new SessionManager(sampleConfig(root), store, runner, { codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId: '019e86b4-12ed-7731-9639-c128626a328e' }));
    await runner.emitOutput(sessionId, 'PTY fallback after observation failure\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

    expect(tail.reply).toContain('PTY fallback after observation failure');
  });

  it('does not discover a delayed codexSessionId for /tail when PTY output is available', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3499';
    const registry = {
      discoverForProject: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: 'not-found' })
        .mockResolvedValueOnce({ ok: true, codexSessionId }),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      codexObservationStore: observationStore,
      codexSessionRegistry: registry as any,
      codexSessionDiscovery: { maxAttempts: 1, retryDelayMs: 0, sleep: async () => undefined },
    });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    registry.discoverForProject.mockClear();
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'completed',
      finalAnswer: '结构化最终答案',
      latestCommentary: '我先看 observation，再决定是否回退。',
      recentToolEvents: [],
    });
    await runner.emitOutput(sessionId, 'raw pty text only\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 80' });

    expect(tail.reply).toContain('raw pty text only');
    expect(tail.reply).not.toContain('结构化最终答案');
    expect(registry.discoverForProject).not.toHaveBeenCalled();
  });

  it('ignores observation parse errors for /tail and still uses PTY output', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, { codexObservationStore: observationStore });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId: '019e86b4-12ed-7731-9639-c128626a3291' }));
    observationStore.snapshots.set('019e86b4-12ed-7731-9639-c128626a3291', {
      availability: { kind: 'parse_error', reason: 'unexpected token at line 1' },
      codexSessionId: '019e86b4-12ed-7731-9639-c128626a3291',
      status: 'unknown',
      recentToolEvents: [],
    });
    await runner.emitOutput(sessionId, 'raw terminal output is still available here\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

    expect(tail.reply).toContain('raw terminal output is still available here');
  });

  it('ignores stale observation snapshots for /tail and uses PTY output', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const observationStore = {
      readSnapshot: vi.fn().mockResolvedValue({
        availability: { kind: 'stale' },
        codexSessionId: '019e86b4-12ed-7731-9639-c128626a328f',
        status: 'running',
        latestCommentary: 'Observation 可能比 PTY 慢一点。',
        recentToolEvents: [],
      }),
    };
    const manager = new SessionManager(sampleConfig(root), store, runner, { codexObservationStore: observationStore as any });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await store.updateSession(sessionId, (latest) => ({
      ...latest,
      codexSessionId: '019e86b4-12ed-7731-9639-c128626a328f',
    }));
    await runner.emitOutput(sessionId, 'raw PTY output appears here\n');

    const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail' });

    expect(tail.reply).toContain('raw PTY output appears here');
    expect(tail.reply).not.toContain('Observation 可能比 PTY 慢一点。');
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

  it('stops the current session immediately with /stop', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    const stopped = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    expect(stopped.reply).toBe(`Stopped session ${sessionId}.`);

    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBeUndefined();
    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('interrupted');

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    const content = await readFile(eventPath, 'utf8');
    expect(content).toContain('"type":"session.stopped"');
  });

  it('stops a starting current session after resume tells the user to stop it', async () => {
    class CountingRunner extends FakeCodexRunner {
      stoppedSessions: string[] = [];

      async stop(sessionId: string): Promise<void> {
        this.stoppedSessions.push(sessionId);
        await super.stop(sessionId);
      }
    }

    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new CountingRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);
    const startingSessionId = 'sess_starting';
    await store.saveSession({
      id: startingSessionId,
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'starting',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      logPath: store.sessionLogPath(startingSessionId),
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: startingSessionId });

    const resumed = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/resume 019e7f20-a667-7632-a808-c9595d77116e repo',
    });
    expect(resumed.reply).toBe(`Current session ${startingSessionId} is still running. Run /stop before resuming another session.`);

    const stopped = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    expect(stopped.reply).toBe(`Stopped session ${startingSessionId}.`);

    expect(runner.stoppedSessions).toEqual([startingSessionId]);
    expect((await store.getChat('oc_1'))?.currentSessionId).toBeUndefined();
    await expect(store.getSession(startingSessionId)).resolves.toMatchObject({
      status: 'interrupted',
      stopRequested: true,
    });
  });

  it('does not stop or relabel a session that already exited before /stop', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const manager = new SessionManager(sampleConfig(root), store, runner);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

    await runner.exit(sessionId, 42);
    const stopped = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });
    expect(stopped.reply).toBe('No running session.');

    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('exited');
    expect(session?.exitCode).toBe(42);
  });

  it('keeps interrupted status when exit callback arrives after /stop', async () => {
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
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/stop' });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const session = await store.getSession(sessionId);
    expect(session?.status).toBe('interrupted');
    expect(session?.exitCode).toBe(0);
  });

  it('preserves exitCode when /stop emits fire-and-forget exit callback', async () => {
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
    const stopped = await manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: '/stop',
    });
    expect(stopped.reply).toBe(`Stopped session ${sessionId}.`);

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

  it('marks current and resumable sessions without exposing native ids in /sessions', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());
    const codexSessionId = '019e7f20-a667-7632-a808-c9595d77116e';

    await store.saveSession({
      id: 'sess_current',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:02:00.000Z',
      logPath: join(root, 'current.log'),
      codexSessionId: '019e7f20-a667-7632-a808-c9595d77116f',
    });
    await store.saveSession({
      id: 'sess_resumable',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:01:00.000Z',
      logPath: join(root, 'resumable.log'),
      codexSessionId,
    });
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: 'sess_current' });

    const listed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/sessions' });

    expect(listed.reply).toContain('sess_current | current | repo | running');
    expect(listed.reply).toContain('sess_resumable | resumable | repo | exited');
    expect(listed.reply).not.toContain(codexSessionId);
    expect(listed.reply).not.toContain('019e7f20-a667-7632-a808-c9595d77116f');
  });

  it('marks sessions without Codex session ids as not-resumable in /sessions', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

    await store.saveSession({
      id: 'sess_missing_native_id',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:01:00.000Z',
      logPath: join(root, 'missing-native-id.log'),
    });

    const listed = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/sessions' });

    expect(listed.reply).toContain('sess_missing_native_id | not-resumable | repo | exited');
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
