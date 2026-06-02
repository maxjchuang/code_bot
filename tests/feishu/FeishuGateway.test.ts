import { describe, expect, it, vi } from 'vitest';
import { LarkLongConnectionGateway } from '../../src/feishu/FeishuGateway.js';

type ReceiveHandler = (data: {
  message?: { chat_id?: string; chat_type?: string; message_type?: string; content?: string };
  sender?: { sender_id?: { open_id?: string } };
}) => Promise<void>;

function createGatewayHarness() {
  let handler: ReceiveHandler | undefined;
  const sent: Array<{ receive_id: string; content: string }> = [];
  const errors: unknown[][] = [];
  const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
  const errorLogs: Array<{ at: string; source: string; message: string; data: Record<string, unknown> }> = [];

  const gateway = new LarkLongConnectionGateway('app', 'secret', {
    client: {
      im: {
        v1: {
          message: {
            create: async ({ data }) => {
              sent.push({ receive_id: data.receive_id, content: data.content });
            },
          },
        },
      },
    },
    wsClient: {
      start: async () => undefined,
    },
    createEventDispatcher: () => ({
      register: (handlers) => {
        handler = handlers['im.message.receive_v1'];
        return handlers;
      },
    }),
    logger: {
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    },
    recordEvent: async (event) => {
      events.push(event);
    },
    recordError: async (entry) => {
      errorLogs.push(entry);
    },
  });

  return {
    gateway,
    sent,
    errors,
    events,
    errorLogs,
    getHandler: () => {
      if (!handler) {
        throw new Error('handler not registered');
      }
      return handler;
    },
  };
}

describe('LarkLongConnectionGateway', () => {
  it('handles text event and sends onMessage reply to original chat', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => 'bot reply');
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello bot' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      text: 'hello bot',
    });
    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'bot reply' }),
      },
    ]);
  });

  it('ignores non-text message events', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => 'reply');
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_1' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
  });

  it('awaits ws startup failures and rejects start', async () => {
    const startupError = new Error('startup failed');
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: { v1: { message: { create: async () => undefined } } },
      },
      wsClient: {
        start: async () => {
          throw startupError;
        },
      },
      createEventDispatcher: () => ({
        register: (handlers) => handlers,
      }),
    });

    await expect(gateway.start(async () => 'ok')).rejects.toThrow('startup failed');
  });

  it('isolates handler errors and logs without throwing', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => {
      throw new Error('handler failed');
    });

    await expect(
      harness.getHandler()({
        message: {
          chat_id: 'oc_1',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        sender: { sender_id: { open_id: 'ou_1' } },
      }),
    ).resolves.toBeUndefined();

    expect(harness.errors.length).toBe(1);
    expect(harness.sent).toEqual([]);
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.message_processing_failed',
        data: expect.objectContaining({
          stage: 'handle_message',
          chatId: 'oc_1',
          userId: 'ou_1',
          errorMessage: 'handler failed',
        }),
      }),
    );
  });

  it('isolates sendText errors and logs without throwing', async () => {
    let handler: ReceiveHandler | undefined;
    const errors: unknown[][] = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async () => {
                throw new Error('send failed');
              },
            },
          },
        },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers) => {
          handler = handlers['im.message.receive_v1'];
          return handlers;
        },
      }),
      logger: { error: (...args: unknown[]) => errors.push(args) },
    });
    await gateway.start(async () => 'reply');
    if (!handler) {
      throw new Error('handler not registered');
    }

    await expect(
      handler({
        message: {
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
        sender: { sender_id: { open_id: 'ou_1' } },
      }),
    ).resolves.toBeUndefined();
    expect(errors.length).toBe(1);
  });

  it('records outbound reply send failures as events', async () => {
    let handler: ReceiveHandler | undefined;
    const errors: unknown[][] = [];
    const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
    const errorLogs: Array<{ at: string; source: string; message: string; data: Record<string, unknown> }> = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async () => {
                const error = new Error('Request failed with status code 400') as Error & {
                  code?: string;
                  response?: { status: number; data: unknown };
                };
                error.code = 'ERR_BAD_REQUEST';
                error.response = {
                  status: 400,
                  data: {
                    code: 230028,
                    msg: 'The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS',
                    log_id: 'log_123',
                  },
                };
                throw error;
              },
            },
          },
        },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers) => {
          handler = handlers['im.message.receive_v1'];
          return handlers;
        },
      }),
      logger: { error: (...args: unknown[]) => errors.push(args) },
      recordEvent: async (event) => {
        events.push(event);
      },
      recordError: async (entry) => {
        errorLogs.push(entry);
      },
    });
    await gateway.start(async () => 'reply');
    if (!handler) {
      throw new Error('handler not registered');
    }

    await expect(
      handler({
        message: {
          chat_id: 'oc_1',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '/tail 20' }),
        },
        sender: { sender_id: { open_id: 'ou_1' } },
      }),
    ).resolves.toBeUndefined();

    expect(errors.length).toBe(1);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.message_processing_failed',
        data: expect.objectContaining({
          stage: 'send_reply',
          chatId: 'oc_1',
          userId: 'ou_1',
          text: '/tail 20',
          replyPreview: 'reply',
          errorMessage: 'Request failed with status code 400',
          errorCode: 'ERR_BAD_REQUEST',
          responseStatus: 400,
          responseData: expect.objectContaining({
            code: 230028,
            msg: expect.stringContaining('EMAIL_ADDRESS'),
            log_id: 'log_123',
          }),
        }),
      }),
    );
    expect(errorLogs).toContainEqual(
      expect.objectContaining({
        source: 'feishu.gateway',
        message: 'Request failed with status code 400',
        data: expect.objectContaining({
          stage: 'send_reply',
          responseStatus: 400,
        }),
      }),
    );
  });

  it('redacts email addresses before sending text', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.sendText('oc_1', 'tail output: user@example.com');

    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'tail output: [EMAIL_REDACTED]' }),
      },
    ]);
  });

  it('splits oversized text replies into multiple Feishu messages', async () => {
    const harness = createGatewayHarness();
    const oversized = 'x'.repeat(16_500);

    await harness.gateway.sendText('oc_1', oversized);

    expect(harness.sent).toHaveLength(2);
    expect(harness.sent[0]?.receive_id).toBe('oc_1');
    expect(harness.sent[1]?.receive_id).toBe('oc_1');

    const firstText = JSON.parse(harness.sent[0]!.content) as { text: string };
    const secondText = JSON.parse(harness.sent[1]!.content) as { text: string };
    expect(firstText.text.length).toBeLessThan(16_500);
    expect(secondText.text.length).toBeGreaterThan(0);
    expect(`${firstText.text}${secondText.text}`).toBe(oversized);
  });

  it('redacts email addresses in replies from incoming messages', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => 'contact: dev-team@example.com');

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: '/tail 20' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'contact: [EMAIL_REDACTED]' }),
      },
    ]);
  });
});
