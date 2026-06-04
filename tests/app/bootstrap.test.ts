import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrap } from '../../src/index.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import type { BotConfig } from '../../src/domain/types.js';
import type { FeishuIncomingMessage } from '../../src/feishu/FeishuGateway.js';
import type { FeishuIncomingCardAction } from '../../src/feishu/FeishuCardActions.js';
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
  logLevel: 'info',
  ui: { verbosity: 'normal' },
  notifications: { enabled: true, idleMs: 3000, maxFinalChars: 8000, failureTailChars: 2000 },
};

const gatewayTargetMethods = {
  sendTextToTarget: async () => undefined,
  sendRenderedMessageToTarget: async () => undefined,
};

describe('bootstrap', () => {
  it('records health check failure and still starts gateway', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const logger = { info: vi.fn(), error: vi.fn() };
    const gatewayStart = vi.fn(async (onMessage: (message: FeishuIncomingMessage) => Promise<{ text: string }>) => {
      await expect(onMessage({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' })).resolves.toEqual({ text: 'ok', rendered: undefined });
    });
    const createGateway = vi.fn(() => ({
      start: gatewayStart,
      sendText: async () => undefined,
      sendRenderedMessage: async () => undefined,
      ...gatewayTargetMethods,
    }));

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

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('startup.health_check_failed'),
    );
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
    const createGateway = vi.fn(() => ({
      start: gatewayStart,
      sendText: async () => undefined,
      sendRenderedMessage: async () => undefined,
      ...gatewayTargetMethods,
    }));

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
    const gateway = { start: vi.fn(), sendText: vi.fn(), sendRenderedMessage: vi.fn(), ...gatewayTargetMethods };
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
    const logger = { info: vi.fn(), error: vi.fn() };
    const gatewayStart = vi.fn(async (onMessage: (message: FeishuIncomingMessage) => Promise<{ text: string }>) => {
      await expect(onMessage({ chatId: 'oc_1', chatType: 'private', userId: 'ou_1', messageId: 'om_123', text: '/tail 20' })).resolves.toEqual({
        text: 'tail output',
        rendered: undefined,
      });
    });

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => sampleConfig(root),
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createGateway: () => ({
        start: gatewayStart,
        sendText: async () => undefined,
        sendRenderedMessage: async () => undefined,
        ...gatewayTargetMethods,
      }),
      logger,
      createApp: () =>
        ({
          sessionManager: { handleText: async () => ({ reply: 'tail output' }) },
          healthCheck: async () => ({ ok: true }),
        }) as never,
    });

    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"command.received"');
    expect(content).toContain('"messageId":"om_123"');
    expect(content).toContain('"text":"/tail 20"');
    expect(content).toContain('"type":"command.replied"');
    expect(content).toContain('"replyPreview":"tail output"');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('startup.ready'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('inbound.received'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('outbound.replied'));
  });

  it('dispatches card actions to the session manager and records card action events', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const logger = { info: vi.fn(), error: vi.fn() };
    const renderedReply = {
      kind: 'interactive-card' as const,
      card: {
        config: { wide_screen_mode: true },
        elements: [],
      },
    };
    const handleCardAction = vi.fn().mockResolvedValue({ reply: 'Current project set to repo2.', renderedReply });
    let onCardAction: ((action: FeishuIncomingCardAction) => Promise<{ text: string; rendered?: unknown }>) | undefined;

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => sampleConfig(root),
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createGateway: () => ({
        start: async (_onMessage, cardActionHandler) => {
          onCardAction = cardActionHandler;
        },
        sendText: async () => undefined,
        sendRenderedMessage: async () => undefined,
        ...gatewayTargetMethods,
      }),
      logger,
      createApp: () =>
        ({
          sessionManager: {
            handleText: async () => ({ reply: 'unused' }),
            handleCardAction,
          },
          healthCheck: async () => ({ ok: true }),
        }) as never,
    });

    expect(onCardAction).toBeDefined();
    const dispatch = onCardAction as (action: FeishuIncomingCardAction) => Promise<{ text: string; rendered?: unknown }>;
    const action = {
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: { kind: 'project_select', projectId: 'repo2' },
    } satisfies FeishuIncomingCardAction;

    await expect(dispatch(action)).resolves.toEqual({
      text: 'Current project set to repo2.',
      rendered: renderedReply,
    });

    expect(handleCardAction).toHaveBeenCalledWith(action);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('inbound.card_action_received'));
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('outbound.card_action_replied'));

    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"card_action.received"');
    expect(content).toContain('"messageId":"om_card_1"');
    expect(content).toContain('"projectId":"repo2"');
    expect(content).toContain('"type":"card_action.replied"');
    expect(content).toContain('"replyPreview":"Current project set to repo2."');
  });

  it('silently drops duplicate inbound message ids before session dispatch', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const handleText = vi.fn().mockResolvedValue({ reply: 'tail output' });
    let onMessage: ((message: FeishuIncomingMessage) => Promise<{ text: string; rendered?: unknown }>) | undefined;

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => sampleConfig(root),
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createGateway: () => ({
        start: async (handler) => {
          onMessage = handler;
        },
        sendText: async () => undefined,
        sendRenderedMessage: async () => undefined,
        ...gatewayTargetMethods,
      }),
      createApp: () =>
        ({
          sessionManager: { handleText },
          healthCheck: async () => ({ ok: true }),
        }) as never,
    });

    expect(onMessage).toBeDefined();
    const dispatch = onMessage as (message: FeishuIncomingMessage) => Promise<{ text: string; rendered?: unknown }>;

    await expect(dispatch({ chatId: 'oc_1', chatType: 'private', userId: 'ou_1', messageId: 'om_123', text: '/tail 20' })).resolves.toEqual({
      text: 'tail output',
      rendered: undefined,
    });
    await expect(dispatch({ chatId: 'oc_1', chatType: 'private', userId: 'ou_1', messageId: 'om_123', text: '/tail 20' })).resolves.toEqual({
      text: '',
      rendered: undefined,
    });

    expect(handleText).toHaveBeenCalledTimes(1);
    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"command.duplicate_dropped"');
    expect(content).toContain('"messageId":"om_123"');
    expect(content).toContain('"duplicateCount":1');
    expect(content.match(/"type":"command.replied"/g)).toHaveLength(1);
  });

  it('continues processing messages without message id', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const handleText = vi.fn().mockResolvedValue({ reply: 'ok' });
    let onMessage: ((message: FeishuIncomingMessage) => Promise<{ text: string; rendered?: unknown }>) | undefined;

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => sampleConfig(root),
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createGateway: () => ({
        start: async (handler) => {
          onMessage = handler;
        },
        sendText: async () => undefined,
        sendRenderedMessage: async () => undefined,
        ...gatewayTargetMethods,
      }),
      createApp: () =>
        ({
          sessionManager: { handleText },
          healthCheck: async () => ({ ok: true }),
        }) as never,
    });

    expect(onMessage).toBeDefined();
    const dispatch = onMessage as (message: FeishuIncomingMessage) => Promise<{ text: string; rendered?: unknown }>;

    await dispatch({ chatId: 'oc_1', chatType: 'private', userId: 'ou_1', text: 'same text' });
    await dispatch({ chatId: 'oc_1', chatType: 'private', userId: 'ou_1', text: 'same text' });

    expect(handleText).toHaveBeenCalledTimes(2);
  });

  it('fails closed when inbound message claim storage fails', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const handleText = vi.fn().mockResolvedValue({ reply: 'ok' });
    const logger = { info: vi.fn(), error: vi.fn() };
    vi.spyOn(store, 'claimInboundMessage').mockRejectedValue(new Error('disk full'));
    let onMessage: ((message: FeishuIncomingMessage) => Promise<{ text: string; rendered?: unknown }>) | undefined;

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => sampleConfig(root),
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createGateway: () => ({
        start: async (handler) => {
          onMessage = handler;
        },
        sendText: async () => undefined,
        sendRenderedMessage: async () => undefined,
        ...gatewayTargetMethods,
      }),
      createApp: () =>
        ({
          sessionManager: { handleText },
          healthCheck: async () => ({ ok: true }),
        }) as never,
      logger,
    });

    expect(onMessage).toBeDefined();
    const dispatch = onMessage as (message: FeishuIncomingMessage) => Promise<{ text: string; rendered?: unknown }>;

    await expect(dispatch({ chatId: 'oc_1', chatType: 'private', userId: 'ou_1', messageId: 'om_123', text: 'status' })).resolves.toEqual({
      text: '',
      rendered: undefined,
    });
    expect(handleText).not.toHaveBeenCalled();
    const day = new Date().toISOString().slice(0, 10);
    const errors = await readFile(join(root, '.code-bot', 'logs/errors', `${day}.jsonl`), 'utf8');
    expect(errors).toContain('"source":"inbound.dedupe"');
    expect(errors).toContain('"message":"disk full"');
  });

  it('records mention diagnostics on inbound command events', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    let onMessage: ((message: FeishuIncomingMessage) => Promise<{ text: string; rendered?: unknown }>) | undefined;

    await bootstrap({
      projectRoot: root,
      loadConfig: async () => sampleConfig(root),
      createStore: () => store,
      createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
      createGateway: () => ({
        start: async (handler) => {
          onMessage = handler;
        },
        sendText: async () => undefined,
        sendRenderedMessage: async () => undefined,
        ...gatewayTargetMethods,
      }),
      createApp: () =>
        ({
          sessionManager: { handleText: async () => ({ reply: '' }) },
          healthCheck: async () => ({ ok: true }),
        }) as never,
    });

    await onMessage?.({
      chatId: 'oc_group',
      chatType: 'group',
      userId: 'ou_1',
      text: '@_user_1 hello',
      wasMentioned: false,
      mentionsOpenIds: ['ou_other'],
      botOpenIdResolved: false,
    });

    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"command.received"');
    expect(content).toContain('"wasMentioned":false');
    expect(content).toContain('"mentionsOpenIds":["ou_other"]');
    expect(content).toContain('"botOpenIdResolved":false');
  });

  it('uses config log level for startup logger when env is unset', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const logger = { info: vi.fn(), error: vi.fn() };
    const gatewayStart = vi.fn(async () => undefined);
    const originalLevel = process.env.LOG_LEVEL;
    delete process.env.LOG_LEVEL;

    try {
      await bootstrap({
        projectRoot: root,
        loadConfig: async () => ({ ...sampleConfig('/tmp/code-bot'), logLevel: 'error' }),
        createStore: () => store,
        createCodexRunner: vi.fn().mockReturnValue(new FakeCodexRunner()),
        createGateway: vi.fn().mockReturnValue({
          start: gatewayStart,
          sendText: async () => undefined,
          sendRenderedMessage: async () => undefined,
          ...gatewayTargetMethods,
        }),
        createApp: () =>
          ({
            sessionManager: { handleText: async () => ({ reply: 'ok' }) },
            healthCheck: async () => ({ ok: true }),
          }) as never,
        logger,
      } as any);
    } finally {
      if (originalLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = originalLevel;
      }
    }

    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('startup.ready'));
    expect(gatewayStart).toHaveBeenCalledOnce();
  });

  it('prefers LOG_LEVEL over config log level', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const logger = { info: vi.fn(), error: vi.fn() };
    const gatewayStart = vi.fn(async () => undefined);
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';

    try {
      await bootstrap({
        projectRoot: root,
        loadConfig: async () => ({ ...sampleConfig('/tmp/code-bot'), logLevel: 'error' }),
        createStore: () => store,
        createCodexRunner: vi.fn().mockReturnValue(new FakeCodexRunner()),
        createGateway: vi.fn().mockReturnValue({
          start: gatewayStart,
          sendText: async () => undefined,
          sendRenderedMessage: async () => undefined,
          ...gatewayTargetMethods,
        }),
        createApp: () =>
          ({
            sessionManager: { handleText: async () => ({ reply: 'ok' }) },
            healthCheck: async () => ({ ok: true }),
          }) as never,
        logger,
      } as any);
    } finally {
      if (originalLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = originalLevel;
      }
    }

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('startup.ready'));
    expect(gatewayStart).toHaveBeenCalledOnce();
  });
});
