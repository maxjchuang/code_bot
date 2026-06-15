import { describe, expect, it, vi } from 'vitest';
import { LarkLongConnectionGateway } from '../../src/feishu/FeishuGateway.js';

type ReceiveHandler = (data: {
  message?: {
    message_id?: string;
    thread_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{ id?: { open_id?: string } }>;
  };
  sender?: { sender_id?: { open_id?: string } };
}) => Promise<void>;

type CardActionHandler = (data: {
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

type BotMenuHandler = (data: {
  event_key?: string;
  operator?: {
    operator_id?: {
      open_id?: string;
    };
  };
  event?: {
    event_key?: string;
    operator?: {
      operator_id?: {
        open_id?: string;
      };
    };
  };
}) => Promise<void>;

function createGatewayHarness() {
  let messageHandler: ReceiveHandler | undefined;
  let cardActionHandler: CardActionHandler | undefined;
  let botMenuHandler: BotMenuHandler | undefined;
  const sent: Array<{ receive_id: string; content: string }> = [];
  const replies: Array<{ message_id: string; msg_type: string; content: string; reply_in_thread?: boolean }> = [];
  const requests: Array<{ url: string; method: string; data?: unknown }> = [];
  const errors: unknown[][] = [];
  const infos: unknown[][] = [];
  const events: Array<{ type: string; at: string; data: Record<string, unknown> }> = [];
  const errorLogs: Array<{ at: string; source: string; message: string; data: Record<string, unknown> }> = [];

  const gateway = new LarkLongConnectionGateway('app', 'secret', {
    client: {
      request: async (payload) => {
        if (payload.url === '/open-apis/bot/v3/info') {
          return {
            bot: {
              open_id: 'ou_bot',
            },
          };
        }
        requests.push({
          url: payload.url,
          method: payload.method,
          data: payload.data,
        });
        return { code: 0, msg: 'success' };
      },
      im: {
        v1: {
          message: {
            create: async ({ data }) => {
              sent.push({ receive_id: data.receive_id, content: data.content });
            },
            reply: async ({ path, data }) => {
              replies.push({
                message_id: path.message_id,
                msg_type: data.msg_type,
                content: data.content,
                reply_in_thread: data.reply_in_thread,
              });
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
        botMenuHandler = handlers['application.bot.menu_v6'];
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
    replies,
    requests,
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
    getBotMenuHandler: () => {
      if (!botMenuHandler) {
        throw new Error('bot menu handler not registered');
      }
      return botMenuHandler;
    },
  };
}

describe('LarkLongConnectionGateway', () => {
  it('adds a Feishu reaction to a message', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.addReaction('om_123', 'Get');

    expect(harness.requests).toEqual([
      {
        url: '/open-apis/im/v1/messages/om_123/reactions',
        method: 'POST',
        data: {
          reaction_type: {
            emoji_type: 'Get',
          },
        },
      },
    ]);
  });

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
    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_123',
        msg_type: 'text',
        content: JSON.stringify({ text: 'bot reply' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('dispatches bot menu events as slash commands using the cached private chat id', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi
      .fn()
      .mockResolvedValueOnce({ text: '' })
      .mockResolvedValueOnce({ text: 'current reply' });
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_seed',
        chat_id: 'oc_private_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    await harness.getBotMenuHandler()({
      event_key: 'current',
      operator: {
        operator_id: {
          open_id: 'ou_1',
        },
      },
    });

    expect(onMessage).toHaveBeenLastCalledWith({
      botOpenIdResolved: true,
      chatId: 'oc_private_1',
      chatType: 'private',
      mentionsOpenIds: [],
      userId: 'ou_1',
      text: '/current',
      wasMentioned: true,
    });
    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_private_1',
        content: JSON.stringify({ text: 'current reply' }),
      },
    ]);
  });

  it.each([
    ['current', '/current'],
    ['tail', '/tail'],
    ['status', '/status'],
    ['project', '/projects'],
    ['projects', '/projects'],
    ['new', '/new'],
    ['model', '/model'],
    ['resume', '/resume'],
    ['stop', '/stop'],
    ['restart', '/restart'],
    ['upgrade', '/upgrade'],
  ])('maps bot menu key %s to %s', async (eventKey, command) => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_seed',
        chat_id: 'oc_private_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });
    onMessage.mockClear();

    await harness.getBotMenuHandler()({
      event: {
        event_key: eventKey,
        operator: {
          operator_id: {
            open_id: 'ou_1',
          },
        },
      },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: command }));
  });

  it('does not use topic replies for ordinary group messages outside a topic', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: 'bot reply' }));

    await harness.getHandler()({
      message: {
        message_id: 'om_group_plain_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@bot hello' }),
        mentions: [{ id: { open_id: 'ou_bot' } }],
      },
      sender: { sender_id: { open_id: 'ou_trigger' } },
    });

    expect(harness.replies).toEqual([
      {
        message_id: 'om_group_plain_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> bot reply' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('uses topic replies for group messages that mention the bot inside a topic', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'bot reply' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_group_topic_1',
        thread_id: 'omt_topic_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@bot hello' }),
        mentions: [{ id: { open_id: 'ou_bot' } }],
      },
      sender: { sender_id: { open_id: 'ou_trigger' } },
    });

    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'omt_topic_1' }));
    expect(harness.replies).toEqual([
      {
        message_id: 'om_group_topic_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> bot reply' }),
        reply_in_thread: true,
      },
    ]);
  });

  it('falls back to chat send when an incoming reply target has no message id', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: 'bot reply' }));
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

    expect(harness.replies).toEqual([]);
    expect(harness.sent).toEqual([
      {
        receive_id: 'oc_1',
        content: JSON.stringify({ text: 'bot reply' }),
      },
    ]);
  });

  it('prefixes group text replies with a mention for the triggering user', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: 'bot reply' }));

    await harness.getHandler()({
      message: {
        message_id: 'om_group_1',
        chat_id: 'oc_1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@bot hello' }),
        mentions: [{ id: { open_id: 'ou_bot' } }],
      },
      sender: { sender_id: { open_id: 'ou_trigger' } },
    });

    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_group_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> bot reply' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('does not prefix private text replies with a mention', async () => {
    const harness = createGatewayHarness();
    await harness.gateway.start(async () => ({ text: 'bot reply' }));

    await harness.getHandler()({
      message: {
        message_id: 'om_private_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello' }),
      },
      sender: { sender_id: { open_id: 'ou_trigger' } },
    });

    expect(harness.replies).toEqual([
      {
        message_id: 'om_private_1',
        msg_type: 'text',
        content: JSON.stringify({ text: 'bot reply' }),
        reply_in_thread: undefined,
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

  it('handles rich text post events by extracting readable text', async () => {
    const harness = createGatewayHarness();
    const onMessage = vi.fn(async () => ({ text: '' }));
    await harness.gateway.start(onMessage);

    await harness.getHandler()({
      message: {
        message_id: 'om_post_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'post',
        content: JSON.stringify({
          title: 'Request',
          content: [
            [
              { tag: 'text', text: 'please inspect ' },
              { tag: 'a', text: 'this MR', href: 'https://example.test/mr/1' },
            ],
            [{ tag: 'text', text: 'thanks' }],
          ],
        }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'oc_1',
        chatType: 'private',
        messageId: 'om_post_1',
        text: 'Request\nplease inspect this MR https://example.test/mr/1\nthanks',
      }),
    );
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

  it('sends rendered replies with source message id through the reply API', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.start(async () => ({
      text: 'fallback',
      rendered: {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } },
        fallback: { kind: 'text', text: 'fallback' },
      },
    }));

    await harness.getHandler()({
      message: {
        message_id: 'om_rendered_1',
        chat_id: 'oc_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello bot' }),
      },
      sender: { sender_id: { open_id: 'ou_1' } },
    });

    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_rendered_1',
        msg_type: 'interactive',
        content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('sends rendered card messages to reply targets through the reply API', async () => {
    const harness = createGatewayHarness();

    await harness.gateway.sendRenderedMessageToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true },
      {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } },
        fallback: { kind: 'text', text: 'fallback' },
      },
    );

    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_123',
        msg_type: 'interactive',
        content: JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } }),
        reply_in_thread: true,
      },
    ]);
  });

  it('prefixes rendered card markdown replies with a card mention', async () => {
    const harness = createGatewayHarness();
    const preferred = { kind: 'card' as const, payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } };

    await harness.gateway.sendRenderedMessageToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true, mentionUserId: 'ou_trigger' },
      {
        preferred,
        fallback: { kind: 'text', text: 'fallback' },
      },
    );

    expect(preferred.payload.body.elements[0]?.content).toBe('**done**');
    expect(harness.replies).toEqual([
      {
        message_id: 'om_123',
        msg_type: 'interactive',
        content: JSON.stringify({
          schema: '2.0',
          body: { elements: [{ tag: 'markdown', content: '<at id="ou_trigger"></at>\n**done**' }] },
        }),
        reply_in_thread: true,
      },
    ]);
  });

  it('mentions rendered text fallback exactly once after preferred card reply failure', async () => {
    const sent: Array<{ receive_id: string; msg_type: string; content: string }> = [];
    let replyCalls = 0;
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { receive_id: string; msg_type: string; content: string } }) => {
                if (payload.data.msg_type === 'interactive') {
                  throw new Error('card fallback create failed');
                }
                sent.push({
                  receive_id: payload.data.receive_id,
                  msg_type: payload.data.msg_type,
                  content: payload.data.content,
                });
              },
              reply: async () => {
                replyCalls += 1;
                throw new Error('reply failed');
              },
            },
          },
        },
      },
      logger: { error: () => undefined },
    } as any);

    await gateway.sendRenderedMessageToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true, mentionUserId: 'ou_trigger' },
      {
        preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [{ tag: 'markdown', content: '**done**' }] } } },
        fallback: { kind: 'text', text: 'fallback text' },
      },
    );

    expect(replyCalls).toBe(2);
    expect(sent).toEqual([
      {
        receive_id: 'oc_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> fallback text' }),
      },
    ]);
  });

  it('logs reply failures and falls back to one chat create payload for text reply targets', async () => {
    const sent: Array<{ receive_id: string; msg_type: string; content: string }> = [];
    const errors: unknown[][] = [];
    const gateway = new LarkLongConnectionGateway('app', 'secret', {
      client: {
        im: {
          v1: {
            message: {
              create: async (payload: { data: { receive_id: string; msg_type: string; content: string } }) => {
                sent.push({
                  receive_id: payload.data.receive_id,
                  msg_type: payload.data.msg_type,
                  content: payload.data.content,
                });
              },
              reply: async () => {
                throw new Error('reply rejected');
              },
            },
          },
        },
      },
      logger: {
        error: (...args: unknown[]) => {
          errors.push(args);
        },
      },
    } as any);

    await gateway.sendTextToTarget(
      { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true },
      'fallback text',
    );

    expect(errors).toContainEqual([
      expect.stringContaining('feishu.reply_message_failed chat=oc_1 messageId=om_123 reason="reply rejected"'),
    ]);
    expect(sent).toEqual([
      {
        receive_id: 'oc_1',
        msg_type: 'text',
        content: JSON.stringify({ text: 'fallback text' }),
      },
    ]);
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
    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_card_1',
        msg_type: 'text',
        content: JSON.stringify({ text: 'model updated' }),
        reply_in_thread: undefined,
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
    expect(harness.sent).toEqual([]);
    expect(harness.replies).toEqual([
      {
        message_id: 'om_card_1',
        msg_type: 'text',
        content: JSON.stringify({ text: '<at user_id="ou_1"></at> project updated' }),
        reply_in_thread: undefined,
      },
    ]);
  });

  it('routes top-level SDK card action payloads to onCardAction', async () => {
    const harness = createGatewayHarness();
    const onCardAction = vi.fn(async () => ({ text: 'project updated' }));

    await harness.gateway.start(async () => ({ text: 'unused' }), onCardAction);

    await harness.getCardActionHandler()({
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
