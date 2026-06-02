import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrap } from '../../src/index.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import type { BotConfig } from '../../src/domain/types.js';
import type { FeishuIncomingMessage } from '../../src/feishu/FeishuGateway.js';
import { FakeCodexRunner, sampleConfig } from '../helpers/fakes.js';
import { createTmpDir } from '../helpers/tmp.js';

const config: BotConfig = {
  feishu: { appId: 'app', appSecret: 'secret' },
  restrictUsers: false,
  restrictChatIds: false,
  allowedUsers: [],
  allowedChatIds: [],
  projects: [],
  output: { directMaxChars: 1000, chunkSize: 500 },
  codex: { command: 'codex', defaultArgs: [] },
  notifications: { enabled: true, idleMs: 3000, maxFinalChars: 8000, failureTailChars: 2000 },
};

describe('bootstrap', () => {
  it('records health check failure and still starts gateway', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const logger = { error: vi.fn() };
    const gatewayStart = vi.fn(async (onMessage: (message: FeishuIncomingMessage) => Promise<string>) => {
      await expect(onMessage({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' })).resolves.toBe('ok');
    });
    const createGateway = vi.fn(() => ({ start: gatewayStart, sendText: async () => undefined }));

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => config,
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createApp: () =>
        ({
          sessionManager: { handleText: async () => ({ reply: 'ok' }) },
          healthCheck: async () => ({ ok: false, reason: 'bad health' }),
        }) as never,
      createGateway,
      logger,
    });

    expect(logger.error).toHaveBeenCalledWith('Codex health check failed: bad health');
    expect(createGateway).toHaveBeenCalledWith(
      'app',
      'secret',
      expect.objectContaining({
        recordEvent: expect.any(Function),
        recordError: expect.any(Function),
      }),
    );
    expect(gatewayStart).toHaveBeenCalledOnce();

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    const content = await readFile(eventPath, 'utf8');
    expect(content).toContain('"type":"codex.health_check_failed"');
    expect(content).toContain('"reason":"bad health"');
  });

  it('recovers stale running sessions before starting gateway', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.saveSession({
      id: 'sess_running',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-05-31T10:00:00.000Z',
      updatedAt: '2026-05-31T10:01:00.000Z',
      logPath: store.sessionLogPath('sess_running'),
    });
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      currentSessionId: 'sess_running',
    });

    const gatewayStart = vi.fn(async () => {
      await expect(store.getSession('sess_running')).resolves.toMatchObject({ status: 'interrupted' });
      await expect(store.getChat('oc_1')).resolves.toMatchObject({ currentProjectId: 'repo' });
      expect((await store.getChat('oc_1'))?.currentSessionId).toBeUndefined();
    });
    const createGateway = vi.fn(() => ({ start: gatewayStart, sendText: async () => undefined }));

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => config,
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createGateway,
    });

    expect(gatewayStart).toHaveBeenCalledOnce();
    const session = await store.getSession('sess_running');
    expect(session?.status).toBe('interrupted');
    expect(session?.lastSummary).toBe('Interrupted during bot restart recovery.');
    const chat = await store.getChat('oc_1');
    expect(chat?.currentSessionId).toBeUndefined();

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    const content = await readFile(eventPath, 'utf8');
    expect(content).toContain('"type":"session.recovered_interrupted"');
    expect(content).toContain('"sessionId":"sess_running"');
  });

  it('creates the app with the Feishu gateway as notifier', async () => {
    const gateway = { start: vi.fn(), sendText: vi.fn() };
    const createApp = vi.fn().mockReturnValue({
      sessionManager: { handleText: vi.fn().mockResolvedValue({ reply: 'ok' }) },
      healthCheck: vi.fn().mockResolvedValue({ ok: true }),
      recoverStartupState: vi.fn().mockResolvedValue(undefined),
    });

    await bootstrap({
      projectRoot: '/tmp/code-bot',
      loadConfig: vi.fn().mockResolvedValue(sampleConfig('/tmp/code-bot')),
      createStore: vi.fn().mockReturnValue({ appendEvent: vi.fn() }),
      createCodexRunner: vi.fn().mockReturnValue(new FakeCodexRunner()),
      createGateway: vi.fn().mockReturnValue(gateway),
      createApp,
    } as any);

    expect(createApp).toHaveBeenCalledWith(expect.objectContaining({ notifier: gateway }));
  });

  it('records inbound message and reply events around gateway dispatch', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const gatewayStart = vi.fn(async (onMessage: (message: FeishuIncomingMessage) => Promise<string>) => {
      await expect(onMessage({ chatId: 'oc_1', chatType: 'private', userId: 'ou_1', text: '/tail 20' })).resolves.toBe('tail output');
    });

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => sampleConfig(root),
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createGateway: () => ({ start: gatewayStart, sendText: async () => undefined }),
      createApp: () =>
        ({
          sessionManager: { handleText: async () => ({ reply: 'tail output' }) },
          healthCheck: async () => ({ ok: true }),
        }) as never,
    });

    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"command.received"');
    expect(content).toContain('"text":"/tail 20"');
    expect(content).toContain('"type":"command.replied"');
    expect(content).toContain('"replyPreview":"tail output"');
  });
});
