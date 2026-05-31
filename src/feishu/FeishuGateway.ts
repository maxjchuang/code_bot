import * as lark from '@larksuiteoapi/node-sdk';
import type { ChatType } from '../domain/types.js';

export interface FeishuIncomingMessage {
  chatId: string;
  chatType: ChatType;
  userId: string;
  text: string;
}

export interface FeishuGateway {
  start(onMessage: (message: FeishuIncomingMessage) => Promise<string>): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
}

interface LarkReceiveMessageEvent {
  message?: {
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
}

interface LarkClientLike {
  im: {
    v1: {
      message: {
        create: (payload: {
          params: { receive_id_type: 'chat_id' };
          data: { receive_id: string; msg_type: 'text'; content: string };
        }) => Promise<unknown>;
      };
    };
  };
}

interface LarkWSClientLike {
  start(options: { eventDispatcher: unknown }): Promise<void> | void;
}

interface EventDispatcherLike {
  register: (handlers: { 'im.message.receive_v1': (data: LarkReceiveMessageEvent) => Promise<void> }) => unknown;
}

interface LoggerLike {
  error: (...args: unknown[]) => void;
}

interface LarkGatewayDeps {
  client?: LarkClientLike;
  wsClient?: LarkWSClientLike;
  createEventDispatcher?: () => EventDispatcherLike;
  logger?: LoggerLike;
}

export class LarkLongConnectionGateway implements FeishuGateway {
  private readonly client: LarkClientLike;
  private readonly wsClient: LarkWSClientLike;
  private readonly createEventDispatcher: () => EventDispatcherLike;
  private readonly logger: LoggerLike;

  constructor(appId: string, appSecret: string, deps?: LarkGatewayDeps) {
    this.client = deps?.client ?? new lark.Client({ appId, appSecret });
    this.wsClient = deps?.wsClient ?? new lark.WSClient({ appId, appSecret });
    this.createEventDispatcher = deps?.createEventDispatcher ?? (() => new lark.EventDispatcher({}));
    this.logger = deps?.logger ?? console;
  }

  async start(onMessage: (message: FeishuIncomingMessage) => Promise<string>): Promise<void> {
    const dispatcher = this.createEventDispatcher();
    dispatcher.register({
        'im.message.receive_v1': async (data: LarkReceiveMessageEvent) => {
          try {
            const message = data.message;
            const sender = data.sender?.sender_id;
            if (!message?.chat_id || !message.content || !sender?.open_id) {
              return;
            }
            if (message.message_type !== 'text') {
              return;
            }

            const content = JSON.parse(message.content) as { text?: string };
            const text = content.text ?? '';

            const reply = await onMessage({
              chatId: message.chat_id,
              chatType: message.chat_type === 'group' ? 'group' : 'private',
              userId: sender.open_id,
              text,
            });

            await this.sendText(message.chat_id, reply);
          } catch (error) {
            this.logger.error('Failed to process Feishu incoming message', error);
          }
        },
      });
    return await this.wsClient.start({
      eventDispatcher: dispatcher,
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }
}
