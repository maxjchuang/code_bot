import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bootstrap } from '../../src/index.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import type { BotConfig } from '../../src/domain/types.js';
import type { FeishuIncomingMessage } from '../../src/feishu/FeishuGateway.js';
import { createTmpDir } from '../helpers/tmp.js';

const config: BotConfig = {
  feishu: { appId: 'app', appSecret: 'secret' },
  allowedUsers: [],
  allowedChatIds: [],
  projects: [],
  output: { directMaxChars: 1000, chunkSize: 500 },
  codex: { command: 'codex', defaultArgs: [] },
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
    expect(createGateway).toHaveBeenCalledWith('app', 'secret');
    expect(gatewayStart).toHaveBeenCalledOnce();

    const day = new Date().toISOString().slice(0, 10);
    const eventPath = join(root, '.code-bot', 'events', `${day}.jsonl`);
    const content = await readFile(eventPath, 'utf8');
    expect(content).toContain('"type":"codex.health_check_failed"');
    expect(content).toContain('"reason":"bad health"');
  });
});
