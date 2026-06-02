import * as lark from '@larksuiteoapi/node-sdk';
import type { ChatType } from '../domain/types.js';
import type { BotErrorLogEntry, BotEvent } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';
import { sanitizeFeishuText } from './FeishuTextSanitizer.js';

export interface FeishuIncomingMessage {
  chatId: string;
  chatType: ChatType;
  userId: string;
  text: string;
}

export interface FeishuGateway {
  start(onMessage: (message: FeishuIncomingMessage) => Promise<FeishuOutgoingReply>): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendRenderedMessage(
    chatId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
}

export interface FeishuOutgoingReply {
  text: string;
  rendered?: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage };
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
          data: { receive_id: string; msg_type: 'text' | 'interactive'; content: string };
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
  recordEvent?: (event: BotEvent) => Promise<void>;
  recordError?: (entry: BotErrorLogEntry) => Promise<void>;
}

const FEISHU_TEXT_MESSAGE_MAX_CHARS = 15_000;

export class LarkLongConnectionGateway implements FeishuGateway {
  private readonly client: LarkClientLike;
  private readonly wsClient: LarkWSClientLike;
  private readonly createEventDispatcher: () => EventDispatcherLike;
  private readonly logger: LoggerLike;
  private readonly recordEvent?: (event: BotEvent) => Promise<void>;
  private readonly recordError?: (entry: BotErrorLogEntry) => Promise<void>;

  constructor(appId: string, appSecret: string, deps?: LarkGatewayDeps) {
    this.client = deps?.client ?? new lark.Client({ appId, appSecret });
    this.wsClient = deps?.wsClient ?? new lark.WSClient({ appId, appSecret });
    this.createEventDispatcher = deps?.createEventDispatcher ?? (() => new lark.EventDispatcher({}));
    this.logger = deps?.logger ?? console;
    this.recordEvent = deps?.recordEvent;
    this.recordError = deps?.recordError;
  }

  async start(onMessage: (message: FeishuIncomingMessage) => Promise<FeishuOutgoingReply>): Promise<void> {
    const dispatcher = this.createEventDispatcher();
    dispatcher.register({
        'im.message.receive_v1': async (data: LarkReceiveMessageEvent) => {
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
          const incomingMessage: FeishuIncomingMessage = {
            chatId: message.chat_id,
            chatType: message.chat_type === 'group' ? 'group' : 'private',
            userId: sender.open_id,
            text,
          };

          let reply: FeishuOutgoingReply;
          try {
            reply = await onMessage(incomingMessage);
          } catch (error) {
            await this.recordProcessingFailure('handle_message', incomingMessage, undefined, error);
            this.logger.error('Failed to process Feishu incoming message', error);
            return;
          }

          try {
            if (reply.rendered) {
              await this.sendRenderedMessage(message.chat_id, reply.rendered);
            } else if (reply.text !== '') {
              await this.sendText(message.chat_id, reply.text);
            }
          } catch (error) {
            await this.recordProcessingFailure('send_reply', incomingMessage, reply.text, error);
            this.logger.error('Failed to process Feishu incoming message', error);
          }
        },
      });
    return await this.wsClient.start({
      eventDispatcher: dispatcher,
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    const sanitizedText = sanitizeFeishuText(text);
    for (const chunk of splitFeishuMessages(sanitizedText)) {
      await this.client.im.v1.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text: chunk }),
        },
      });
    }
  }

  async sendRenderedMessage(
    chatId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void> {
    try {
      await this.sendOne(chatId, message.preferred);
    } catch {
      await this.sendOne(chatId, message.fallback);
    }
  }

  private async sendOne(chatId: string, message: RenderedFeishuMessage): Promise<void> {
    if (message.kind === 'text') {
      await this.sendText(chatId, message.text);
      return;
    }

    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(message.payload),
      },
    });
  }

  private async recordProcessingFailure(
    stage: 'handle_message' | 'send_reply',
    message: FeishuIncomingMessage,
    reply: string | undefined,
    error: unknown,
  ): Promise<void> {
    const at = new Date().toISOString();
    const details = serializeError(error);
    const data: Record<string, unknown> = {
      stage,
      chatId: message.chatId,
      chatType: message.chatType,
      userId: message.userId,
      text: message.text,
      ...details,
    };
    if (reply !== undefined) {
      data.replyPreview = reply.length <= 200 ? reply : `${reply.slice(0, 197)}...`;
    }

    if (this.recordEvent) {
      await this.recordEvent({
        type: 'feishu.message_processing_failed',
        at,
        data,
      });
    }
    if (this.recordError) {
      const errorMessage = typeof details.errorMessage === 'string' ? details.errorMessage : 'Unknown error';
      await this.recordError({
        at,
        source: 'feishu.gateway',
        message: errorMessage,
        data,
      });
    }
  }
}

function splitFeishuMessages(text: string): string[] {
  if (text.length <= FEISHU_TEXT_MESSAGE_MAX_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += FEISHU_TEXT_MESSAGE_MAX_CHARS) {
    chunks.push(text.slice(index, index + FEISHU_TEXT_MESSAGE_MAX_CHARS));
  }
  return chunks;
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const result: Record<string, unknown> = {
      errorMessage: error.message,
    };
    const maybeCode = Reflect.get(error, 'code');
    if (typeof maybeCode === 'string' && maybeCode.length > 0) {
      result.errorCode = maybeCode;
    }
    const maybeStack = Reflect.get(error, 'stack');
    if (typeof maybeStack === 'string' && maybeStack.length > 0) {
      result.errorStack = maybeStack;
    }
    const maybeResponse = Reflect.get(error, 'response');
    if (typeof maybeResponse === 'object' && maybeResponse !== null) {
      const status = Reflect.get(maybeResponse, 'status');
      if (typeof status === 'number') {
        result.responseStatus = status;
      }
      const data = Reflect.get(maybeResponse, 'data');
      if (data !== undefined) {
        result.responseData = normalizeUnknown(data);
      }
    }
    return result;
  }

  return {
    errorMessage: typeof error === 'string' ? error : String(error),
    errorValue: normalizeUnknown(error),
  };
}

function normalizeUnknown(value: unknown): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeUnknown(item));
  }
  if (typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      normalized[key] = normalizeUnknown(entry);
    }
    return normalized;
  }
  return String(value);
}
