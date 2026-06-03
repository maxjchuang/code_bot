import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/loadConfig.js';
import { FileStateStore } from './state/FileStateStore.js';
import { PtyCodexRunner } from './codex/CodexRunner.js';
import { createApp, recoverStartupState } from './app/createApp.js';
import { LarkLongConnectionGateway, type FeishuGateway } from './feishu/FeishuGateway.js';
import type { BotConfig } from './domain/types.js';
import type { FileStateStore as FileStateStoreType } from './state/FileStateStore.js';
import type { CodexRunner } from './codex/CodexRunner.js';
import type { SessionManager } from './session/SessionManager.js';
import { createAppLogger } from './logging/AppLogger.js';

export interface BootstrapDeps {
  projectRoot?: string;
  loadConfig?: (projectRoot: string) => Promise<BotConfig>;
  createStore?: (projectRoot: string) => FileStateStoreType;
  createCodexRunner?: (config: BotConfig['codex']) => CodexRunner;
  createApp?: (args: {
    projectRoot: string;
    config: BotConfig;
    store: FileStateStoreType;
    codexRunner: CodexRunner;
    notifier?: FeishuGateway;
  }) => {
    sessionManager: SessionManager;
    healthCheck: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    recoverStartupState?: () => Promise<void>;
  };
  createGateway?: (
    appId: string,
    appSecret: string,
    observability?: {
      logLevel?: BotConfig['logLevel'];
      recordEvent: (event: import('./domain/types.js').BotEvent) => Promise<void>;
      recordError: (entry: import('./domain/types.js').BotErrorLogEntry) => Promise<void>;
    },
  ) => FeishuGateway;
  logger?: Pick<typeof console, 'info' | 'error'>;
}

export async function bootstrap(deps: BootstrapDeps = {}): Promise<void> {
  const projectRoot = deps.projectRoot ?? cwd();
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const createStoreFn = deps.createStore ?? ((root: string) => new FileStateStore(root));
  const createCodexRunnerFn = deps.createCodexRunner ?? ((config: BotConfig['codex']) => new PtyCodexRunner(config));
  const createAppFn = deps.createApp ?? createApp;
  const createGatewayFn =
    deps.createGateway ??
    ((appId: string, appSecret: string, observability?: { logLevel?: BotConfig['logLevel']; recordEvent: (event: import('./domain/types.js').BotEvent) => Promise<void>; recordError: (entry: import('./domain/types.js').BotErrorLogEntry) => Promise<void> }) =>
      new LarkLongConnectionGateway(appId, appSecret, observability));

  const config = await loadConfigFn(projectRoot);
  const logger = createAppLogger({ level: config.logLevel, sink: deps.logger ?? console });
  const store = createStoreFn(projectRoot);
  const codexRunner = createCodexRunnerFn(config.codex);
  const gateway = createGatewayFn(config.feishu.appId, config.feishu.appSecret, {
    logLevel: config.logLevel,
    recordEvent: (event) => store.appendEvent(event),
    recordError: (entry) => store.appendErrorLog(entry),
  });
  const app = createAppFn({ projectRoot, config, store, codexRunner, notifier: gateway });
  const health = await app.healthCheck();
  if (!health.ok) {
    logger.error('startup.health_check_failed', { reason: health.reason });
    try {
      await store.appendEvent({
        type: 'codex.health_check_failed',
        at: new Date().toISOString(),
        data: { reason: health.reason },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('startup.health_check_record_failed', { reason: message });
    }
  }
  await (app.recoverStartupState?.() ?? recoverStartupState(store));
  logger.info('startup.ready', {
    projects: config.projects.length,
    verbosity: config.ui.verbosity,
  });
  await gateway.start(async (message) => {
    logger.info('inbound.received', {
      chat: message.chatId,
      type: message.chatType,
      text: message.text,
    });
    const receivedAt = new Date().toISOString();
    await store.appendEvent({
      type: 'command.received',
      at: receivedAt,
      data: {
        chatId: message.chatId,
        chatType: message.chatType,
        userId: message.userId,
        text: message.text,
        wasMentioned: message.wasMentioned,
        mentionsOpenIds: message.mentionsOpenIds,
        botOpenIdResolved: message.botOpenIdResolved,
      },
    });
    const result = await app.sessionManager.handleText(message);
    logger.info('outbound.replied', {
      chat: message.chatId,
      type: message.chatType,
      reply: result.reply,
    });
    await store.appendEvent({
      type: 'command.replied',
      at: new Date().toISOString(),
      data: {
        chatId: message.chatId,
        chatType: message.chatType,
        userId: message.userId,
        text: message.text,
        replyPreview: result.reply.length <= 200 ? result.reply : `${result.reply.slice(0, 197)}...`,
      },
    });
    return { text: result.reply, rendered: result.renderedReply };
  });
}

async function main(): Promise<void> {
  await bootstrap();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main };
