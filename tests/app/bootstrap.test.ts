import { describe, expect, it, vi } from 'vitest';
import { bootstrap } from '../../src/index.js';
import type { BotConfig } from '../../src/domain/types.js';

const config: BotConfig = {
  feishu: { appId: 'app', appSecret: 'secret' },
  allowedUsers: [],
  allowedChatIds: [],
  projects: [],
  output: { directMaxChars: 1000, chunkSize: 500 },
  codex: { command: 'codex', defaultArgs: [] },
};

describe('bootstrap', () => {
  it('fails fast and does not start gateway when health check fails', async () => {
    const logger = { error: vi.fn() };
    const gatewayStart = vi.fn(async () => undefined);
    const createGateway = vi.fn(() => ({ start: gatewayStart, sendText: async () => undefined }));

    await expect(
      bootstrap({
        projectRoot: '/tmp/test',
        loadConfig: async () => config,
        createStore: () => ({} as never),
        createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
        createApp: () =>
          ({
            sessionManager: { handleText: async () => ({ reply: 'ok' }) },
            healthCheck: async () => ({ ok: false, reason: 'bad health' }),
          }) as never,
        createGateway,
        logger,
      }),
    ).rejects.toThrow('Health check failed: bad health');

    expect(logger.error).toHaveBeenCalledWith('bad health');
    expect(createGateway).not.toHaveBeenCalled();
    expect(gatewayStart).not.toHaveBeenCalled();
  });
});
