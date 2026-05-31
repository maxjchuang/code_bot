import { cwd } from 'node:process';
import { loadConfig } from './config/loadConfig.js';
import { FileStateStore } from './state/FileStateStore.js';
import { PtyCodexRunner } from './codex/CodexRunner.js';
import { createApp } from './app/createApp.js';
import { LarkLongConnectionGateway } from './feishu/FeishuGateway.js';

async function main(): Promise<void> {
  const projectRoot = cwd();
  const config = await loadConfig(projectRoot);
  const store = new FileStateStore(projectRoot);
  const codexRunner = new PtyCodexRunner(config.codex);
  const app = createApp({ projectRoot, config, store, codexRunner });
  const health = await app.healthCheck();
  if (!health.ok) {
    console.error(health.reason);
  }
  const gateway = new LarkLongConnectionGateway(config.feishu.appId, config.feishu.appSecret);
  await gateway.start((message) => app.sessionManager.handleText(message).then((result) => result.reply));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
