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
  }) => {
    sessionManager: SessionManager;
    healthCheck: () => Promise<{ ok: true } | { ok: false; reason: string }>;
    recoverStartupState?: () => Promise<void>;
  };
  createGateway?: (appId: string, appSecret: string) => FeishuGateway;
  logger?: Pick<typeof console, 'error'>;
}

export async function bootstrap(deps: BootstrapDeps = {}): Promise<void> {
  const projectRoot = deps.projectRoot ?? cwd();
  const loadConfigFn = deps.loadConfig ?? loadConfig;
  const createStoreFn = deps.createStore ?? ((root: string) => new FileStateStore(root));
  const createCodexRunnerFn = deps.createCodexRunner ?? ((config: BotConfig['codex']) => new PtyCodexRunner(config));
  const createAppFn = deps.createApp ?? createApp;
  const createGatewayFn = deps.createGateway ?? ((appId: string, appSecret: string) => new LarkLongConnectionGateway(appId, appSecret));
  const logger = deps.logger ?? console;

  const config = await loadConfigFn(projectRoot);
  const store = createStoreFn(projectRoot);
  const codexRunner = createCodexRunnerFn(config.codex);
  const app = createAppFn({ projectRoot, config, store, codexRunner });
  const health = await app.healthCheck();
  if (!health.ok) {
    logger.error(`Codex health check failed: ${health.reason}`);
    try {
      await store.appendEvent({
        type: 'codex.health_check_failed',
        at: new Date().toISOString(),
        data: { reason: health.reason },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to record Codex health check failure: ${message}`);
    }
  }
  await (app.recoverStartupState?.() ?? recoverStartupState(store));
  const gateway = createGatewayFn(config.feishu.appId, config.feishu.appSecret);
  await gateway.start((message) => app.sessionManager.handleText(message).then((result) => result.reply));
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
