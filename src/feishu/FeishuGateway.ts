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
    content?: string;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
}

export class LarkLongConnectionGateway implements FeishuGateway {
  private readonly client: lark.Client;
  private readonly wsClient: lark.WSClient;

  constructor(appId: string, appSecret: string) {
    this.client = new lark.Client({ appId, appSecret });
    this.wsClient = new lark.WSClient({ appId, appSecret });
  }

  async start(onMessage: (message: FeishuIncomingMessage) => Promise<string>): Promise<void> {
    this.wsClient.start({
      eventDispatcher: new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: LarkReceiveMessageEvent) => {
          const message = data.message;
          const sender = data.sender?.sender_id;
          if (!message?.chat_id || !message.content || !sender?.open_id) {
            return;
          }

          let text = '';
          try {
            const content = JSON.parse(message.content) as { text?: string };
            text = content.text ?? '';
          } catch {
            return;
          }

          const reply = await onMessage({
            chatId: message.chat_id,
            chatType: message.chat_type === 'group' ? 'group' : 'private',
            userId: sender.open_id,
            text,
          });

          await this.sendText(message.chat_id, reply);
        },
      }),
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
