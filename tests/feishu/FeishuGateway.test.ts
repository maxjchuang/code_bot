import { describe, expect, it, vi } from 'vitest';
import { LarkLongConnectionGateway } from '../../src/feishu/FeishuGateway.js';

type ReceiveHandler = (data: {
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ id?: { open_id?: string } }>;
  };
  sender?: { sender_id?: { open_id?: string } };
}) => Promise<void>;

type CardActionHandler = (data: {
  event?: {
    context?: {
      open_chat_id?: string;
      open_message_id?: string;
    };
    open_chat_id?: string;
    open_message_id?: string;
    operator?: {
      open_id?: string;
    };
    action?: {
      value?: unknown;
      form_value?: unknown;
    };
  };
}) => Promise<void>;

function createGatewayHarness() {
  let messageHandler: ReceiveHandler | undefined;
  let cardActionHandler: CardActionHandler | undefined;
  const sent: Array<{ receive_id: string; content: string }> = [];
  const errors: unknown[][] = [];
  const infos: unknown[][] = [];
  const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
  const errorLogs: Array<{ at: string; source: string; message: string; data: Record<string, unknown> }> = [];

  const gateway = new LarkLongConnectionGateway('app', 'secret', {
    client: {
      request: async () => ({
        bot: {
          open_id: 'ou_bot',
        },
      }),
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
        messageHandler = handlers['im.message.receive_v1'];
        cardActionHandler = handlers['card.action.trigger'];
        return handlers;
      },
    }),
    logger: {
      info: (...args: unknown[]) => {
        infos.push(args);
      },
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
    infos,
    events,
    errorLogs,
    getHandler: () => {
      if (!messageHandler) {
        throw new Error('handler not registered');
      }
      return messageHandler;
    },
    getCardActionHandler: () => {
      if (!cardActionHandler) {
        throw new Error('card action handler not registered');
      }
      return cardActionHandler;
    },
  };
}

describe('LarkLongConnectionGateway', () => {
  it('handles text event and sends onMessage reply to original chat', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'bot reply' }));
    await harness.gateway.start(onMessage);
    expect(harness.infos).toContainEqual([expect.stringContaining('gateway.started')]);

    await harness.getHandler()({
      message: {
        message_id: 'om_123',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello bot' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({
      botOpenIdResolved: true,
      chatId: 'oc_1',
      chatType: 'private',
      messageId: 'om_123',
      mentionsOpenIds: [],
      userId: 'ou_1',
      text: 'hello bot',
      wasMentioned: false,
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
    const onMessage = vi.fn(async () => ({ text: 'reply' }));
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

  it('marks group messages as mentioned only when they mention the bot identity', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [{ id: { open_id: 'ou_other' } }],
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 hello' }),
        mentions: [{ id: { open_id: 'ou_bot' } }],
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenNthCalledWith(1, {
      botOpenIdResolved: true,
      chatId: 'oc_1',
      chatType: 'group',
      mentionsOpenIds: ['ou_other'],
      userId: 'ou_1',
      text: '@_user_1 hello',
      wasMentioned: false,
    });
    expect(onMessage).toHaveBeenNthCalledWith(2, {
      botOpenIdResolved: true,
      chatId: 'oc_1',
      chatType: 'group',
      mentionsOpenIds: ['ou_bot'],
      userId: 'ou_1',
      text: '@_user_1 hello',
      wasMentioned: true,
    });
  });

  it('records bot identity resolution success on startup', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.start(async () => ({ text: '' }));

    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.bot_identity_resolved',
        data: {
          botOpenId: 'ou_bot',
        },
      }),
    );
  });

  it('records bot identity lookup failures on startup', async () => {
    const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
    const errors: unknown[][] = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        request: async () => {
          throw new Error('identity lookup failed');
        },
        im: { v1: { message: { create: async () => undefined } } },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers) => handlers,
      }),
      logger: { error: (...args: unknown[]) => errors.push(args) },
      recordEvent: async (event) => {
        events.push(event);
      },
    });

    await gateway.start(async () => ({ text: '' }));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.bot_identity_failed',
        data: expect.objectContaining({
          reason: 'identity lookup failed',
          stage: 'resolve_bot_open_id',
        }),
      }),
    );
    expect(errors).toContainEqual([expect.stringContaining('feishu.bot_identity_failed')]);
  });

  it('records missing bot open id as an identity failure on startup', async () => {
    const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        request: async () => ({
          bot: {},
        }),
        im: { v1: { message: { create: async () => undefined } } },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers) => handlers,
      }),
      recordEvent: async (event) => {
        events.push(event);
      },
    });

    await gateway.start(async () => ({ text: '' }));

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'feishu.bot_identity_failed',
        data: expect.objectContaining({
          reason: 'empty_open_id',
          stage: 'resolve_bot_open_id',
        }),
      }),
    );
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

    await expect(gateway.start(async () => ({ text: 'ok' }))).rejects.toThrow('startup failed');
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
        register: (handlers: { 'im.message.receive_v1': ReceiveHandler }) => {
          handler = handlers['im.message.receive_v1'];
          return handlers;
        },
      }),
      logger: { error: (...args: unknown[]) => errors.push(args) },
    });
    await gateway.start(async () => ({ text: 'reply' }));
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
        register: (handlers: { 'im.message.receive_v1': ReceiveHandler }) => {
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
    await gateway.start(async () => ({ text: 'reply' }));
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
    await harness.gateway.start(async () => ({ text: 'contact: dev-team@example.com' }));

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

  it('sends a card payload when the reply is rendered as a card', async () => {
    const sent: Array<{ msg_type: string; content: string }> = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { msg_type: string; content: string } }) => {
                const { data } = payload;
                sent.push({ msg_type: data.msg_type, content: data.content });
              },
            },
          },
        },
      },
    } as any);

    await gateway.sendRenderedMessage('oc_1', {
      preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
      fallback: { kind: 'text', text: 'fallback' },
    });

    expect(sent[0]).toMatchObject({ msg_type: 'interactive' });
  });

  it('falls back to text when card sending fails', async () => {
    const sent: Array<{ msg_type: string; content: string }> = [];
    const infos: unknown[][] = [];
    let calls = 0;
    const originalLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = 'debug';
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { msg_type: string; content: string } }) => {
                const { data } = payload;
                calls += 1;
                if (calls === 1) {
                  throw new Error('card failed');
                }
                sent.push({ msg_type: data.msg_type, content: data.content });
              },
            },
          },
        },
      },
      logger: {
        info: (...args: unknown[]) => {
          infos.push(args);
        },
        error: () => undefined,
      },
    } as any);

    try {
      await gateway.sendRenderedMessage('oc_1', {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
        fallback: { kind: 'text', text: 'fallback text' },
      });
    } finally {
      if (originalLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = originalLevel;
      }
    }

    expect(sent).toEqual([{ msg_type: 'text', content: JSON.stringify({ text: 'fallback text' }) }]);
    expect(infos).toContainEqual([expect.stringContaining('DEBUG feishu.render_fallback')]);
  });

  it('sends rendered replies from the incoming message handler as cards', async () => {
    const sent: Array<{ msg_type?: string; content: string }> = [];
    let handler: ReceiveHandler | undefined;
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { msg_type?: string; content: string } }) => {
                sent.push({ msg_type: payload.data.msg_type, content: payload.data.content });
              },
            },
          },
        },
      },
      wsClient: { start: async () => undefined },
      createEventDispatcher: () => ({
        register: (handlers: { 'im.message.receive_v1': ReceiveHandler }) => {
          handler = handlers['im.message.receive_v1'];
          return handlers;
        },
      }),
    } as any);

    await gateway.start(async () => ({
      text: 'fallback',
      rendered: {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } },
        fallback: { kind: 'text', text: 'fallback' },
      },
    }));

    if (!handler) {
      throw new Error('handler not registered');
    }

    await handler({
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello bot' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg_type).toBe('interactive');
  });

  it('does not send an empty reply payload back to Feishu', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: '' }));

    await harness.getHandler()({
      message: {
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(harness.sent).toEqual([]);
  });

  it('routes model selector card actions to onCardAction using origin chat id', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'should not be used' }));
    const onCardAction = vi.fn(async () => ({ text: 'model updated' }));

    await harness.gateway.start(onMessage, onCardAction);

    await harness.getCardActionHandler()({
      event: {
        context: {
          open_chat_id: 'oc_1',
          open_message_id: 'om_card_1',
        },
        operator: {
          open_id: 'ou_1',
        },
        action: {
          value: {
            kind: 'model_select',
            chatId: 'oc_1',
            chatType: 'private',
          },
          form_value: {
            model: 'gpt-5.5',
            reasoning: 'high',
          },
        },
      },
    });

    expect(onMessage).not.toHaveBeenCalled();
    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: {
        kind: 'model_select',
        model: 'gpt-5.5',
        reasoning: 'high',
      },
    });
    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'model updated' }),
      },
    ]);
  });

  it('routes project selector card actions from form_value to onCardAction using origin chat id', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'project updated' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({
      event: {
        context: {
          open_chat_id: 'oc_1',
          open_message_id: 'om_card_1',
        },
        operator: {
          open_id: 'ou_1',
        },
        action: {
          value: {
            kind: 'project_select',
            chatId: 'oc_1',
            chatType: 'group',
          },
          form_value: {
            projectId: 'repo2',
          },
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledTimes(1);
    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: {
        kind: 'project_select',
        projectId: 'repo2',
      },
    });
    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'project updated' }),
      },
    ]);
  });

  it('ignores card actions when origin chat differs from embedded payload chat', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'unused' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await expect(
      harness.getCardActionHandler()({
        event: {
          context: {
            open_chat_id: 'oc_real',
            open_message_id: 'om_card_1',
          },
          operator: {
            open_id: 'ou_1',
          },
          action: {
            value: {
              kind: 'model_select',
              chatId: 'oc_embedded',
              chatType: 'group',
            },
            form_value: {
              model: 'gpt-5.5',
            },
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(onCardAction).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it('uses top-level origin chat and message id fallback for card actions', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'model updated' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({
      event: {
        open_chat_id: 'oc_1',
        open_message_id: 'om_card_top_level',
        operator: {
          open_id: 'ou_1',
        },
        action: {
          value: {
            kind: 'model_select',
            chatId: 'oc_1',
            chatType: 'private',
          },
          form_value: {
            model: 'gpt-5.5',
          },
        },
      },
    });

    expect(onCardAction).toHaveBeenCalledWith({
      chatId: 'oc_1',
      chatType: 'private',
      userId: 'ou_1',
      messageId: 'om_card_top_level',
      action: {
        kind: 'model_select',
        model: 'gpt-5.5',
      },
    });
  });

  it('ignores card actions when origin chat id is missing', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'unused' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await expect(
      harness.getCardActionHandler()({
        event: {
          context: {
            open_message_id: 'om_card_1',
          },
          operator: {
            open_id: 'ou_1',
          },
          action: {
            value: {
              kind: 'model_select',
              chatId: 'oc_1',
              chatType: 'group',
            },
            form_value: {
              model: 'gpt-5.5',
            },
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(onCardAction).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.errors).toEqual([]);
  });

  it('ignores malformed card actions without throwing', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'unused' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await expect(
      harness.getCardActionHandler()({
        event: {
          operator: {
            open_id: 'ou_1',
          },
          action: {
            value: {
              kind: 'model_select',
              chatId: 'oc_1',
            },
            form_value: {
              reasoning: 'high',
            },
          },
        },
      }),
    ).resolves.toBeUndefined();

    expect(onCardAction).not.toHaveBeenCalled();
    expect(harness.sent).toEqual([]);
    expect(harness.errors).toEqual([]);
  });
});
