import { cwd } from 'node:process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/loadConfig.js';
import { FileStateStore } from './state/FileStateStore.js';
import { PtyCodexRunner } from './codex/CodexRunner.js';
import { createApp, recoverStartupState } from './app/createApp.js';
import { LarkLongConnectionGateway, type FeishuGateway, type FeishuIncomingMessage } from './feishu/FeishuGateway.js';
import type { BotConfig, ClaimInboundMessageResult } from './domain/types.js';
import type { FileStateStore as FileStateStoreType } from './state/FileStateStore.js';
import type { CodexRunner } from './codex/CodexRunner.js';
import type { SessionManager } from './session/SessionManager.js';
import { createAppLogger } from './logging/AppLogger.js';
import type { FeishuIncomingCardAction } from './feishu/FeishuCardActions.js';

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
  const onMessage = async (message: FeishuIncomingMessage) => {
    logger.info('inbound.received', {
      chat: message.chatId,
      type: message.chatType,
      messageId: message.messageId,
      threadId: message.threadId,
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
        messageId: message.messageId,
        threadId: message.threadId,
        text: message.text,
        wasMentioned: message.wasMentioned,
        mentionsOpenIds: message.mentionsOpenIds,
        botOpenIdResolved: message.botOpenIdResolved,
      },
    });
    let claim: ClaimInboundMessageResult;
    try {
      claim = await store.claimInboundMessage(message);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('inbound.dedupe_failed', {
        chat: message.chatId,
        type: message.chatType,
        messageId: message.messageId,
        reason: errorMessage,
      });
      await store.appendErrorLog({
        at: new Date().toISOString(),
        source: 'inbound.dedupe',
        message: errorMessage,
        data: {
          chatId: message.chatId,
          chatType: message.chatType,
          userId: message.userId,
          messageId: message.messageId,
        },
      });
      return { text: '', rendered: undefined };
    }

    if (!claim.claimed) {
      await store.appendEvent({
        type: 'command.duplicate_dropped',
        at: new Date().toISOString(),
        data: {
          chatId: message.chatId,
          chatType: message.chatType,
          userId: message.userId,
          messageId: message.messageId,
          text: message.text,
          duplicateCount: claim.receipt.duplicateCount,
        },
      });
      return { text: '', rendered: undefined };
    }

    const result = await app.sessionManager.handleText(message);
    logger.info('outbound.replied', {
      chat: message.chatId,
      type: message.chatType,
      messageId: message.messageId,
      reply: result.reply,
    });
    await store.appendEvent({
      type: 'command.replied',
      at: new Date().toISOString(),
      data: {
        chatId: message.chatId,
        chatType: message.chatType,
        userId: message.userId,
        messageId: message.messageId,
        text: message.text,
        replyPreview: result.reply.length <= 200 ? result.reply : `${result.reply.slice(0, 197)}...`,
      },
    });
    return { text: result.reply, rendered: result.renderedReply };
  };
  const onCardAction = async (action: FeishuIncomingCardAction) => {
    logger.info('inbound.card_action_received', {
      chat: action.chatId,
      type: action.chatType,
      messageId: action.messageId,
      kind: action.action.kind,
    });
    await store.appendEvent({
      type: 'card_action.received',
      at: new Date().toISOString(),
      data: {
        chatId: action.chatId,
        chatType: action.chatType,
        userId: action.userId,
        messageId: action.messageId,
        action: action.action,
      },
    });
    const result = await app.sessionManager.handleCardAction(action);
    logger.info('outbound.card_action_replied', {
      chat: action.chatId,
      type: action.chatType,
      messageId: action.messageId,
      kind: action.action.kind,
      reply: result.reply,
    });
    await store.appendEvent({
      type: 'card_action.replied',
      at: new Date().toISOString(),
      data: {
        chatId: action.chatId,
        chatType: action.chatType,
        userId: action.userId,
        messageId: action.messageId,
        action: action.action,
        replyPreview: result.reply.length <= 200 ? result.reply : `${result.reply.slice(0, 197)}...`,
      },
    });
    return { text: result.reply, rendered: result.renderedReply };
  };
  await gateway.start(onMessage, onCardAction);
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
