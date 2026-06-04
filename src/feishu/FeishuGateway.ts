import * as lark from '@larksuiteoapi/node-sdk';
import type { ChatType } from '../domain/types.js';
import type { BotErrorLogEntry, BotEvent } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';
import type { FeishuIncomingCardAction } from './FeishuCardActions.js';
import { parseCardActionValue } from './FeishuCardActions.js';
import { sanitizeFeishuText } from './FeishuTextSanitizer.js';
import { createAppLogger, type AppLogger, type LogLevel } from '../logging/AppLogger.js';

export interface FeishuIncomingMessage {
  chatId: string;
  chatType: ChatType;
  userId: string;
  messageId?: string;
  text: string;
  wasMentioned?: boolean;
  mentionsOpenIds?: string[];
  botOpenIdResolved?: boolean;
}

export interface FeishuGateway {
  start(
    onMessage: (message: FeishuIncomingMessage) => Promise<FeishuOutgoingReply>,
    onCardAction?: (action: FeishuIncomingCardAction) => Promise<FeishuOutgoingReply>,
  ): Promise<void>;
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
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: Array<{
      id?: {
        open_id?: string;
      };
    }>;
  };
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
}

interface LarkCardActionEvent {
  event?: {
    context?: {
      open_message_id?: string;
    };
    operator?: {
      open_id?: string;
    };
    action?: {
      value?: unknown;
      form_value?: unknown;
    };
  };
}

interface LarkClientLike {
  request?: (payload: { url: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; [key: string]: unknown }) => Promise<unknown>;
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
  register: (handlers: {
    'im.message.receive_v1': (data: LarkReceiveMessageEvent) => Promise<void>;
    'card.action.trigger'?: (data: LarkCardActionEvent) => Promise<void>;
  }) => unknown;
}

interface LoggerLike {
  info?: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

interface LarkGatewayDeps {
  client?: LarkClientLike;
  wsClient?: LarkWSClientLike;
  createEventDispatcher?: () => EventDispatcherLike;
  logger?: LoggerLike;
  logLevel?: LogLevel;
  recordEvent?: (event: BotEvent) => Promise<void>;
  recordError?: (entry: BotErrorLogEntry) => Promise<void>;
}

const FEISHU_TEXT_MESSAGE_MAX_CHARS = 15_000;

export class LarkLongConnectionGateway implements FeishuGateway {
  private readonly client: LarkClientLike;
  private readonly wsClient: LarkWSClientLike;
  private readonly createEventDispatcher: () => EventDispatcherLike;
  private readonly logger: AppLogger;
  private readonly recordEvent?: (event: BotEvent) => Promise<void>;
  private readonly recordError?: (entry: BotErrorLogEntry) => Promise<void>;
  private botOpenId?: string;

  constructor(appId: string, appSecret: string, deps?: LarkGatewayDeps) {
    this.client = deps?.client ?? new lark.Client({ appId, appSecret });
    this.wsClient = deps?.wsClient ?? new lark.WSClient({ appId, appSecret });
    this.createEventDispatcher = deps?.createEventDispatcher ?? (() => new lark.EventDispatcher({}));
    this.logger = createAppLogger({ level: deps?.logLevel, sink: deps?.logger ?? console });
    this.recordEvent = deps?.recordEvent;
    this.recordError = deps?.recordError;
  }

  async start(
    onMessage: (message: FeishuIncomingMessage) => Promise<FeishuOutgoingReply>,
    onCardAction?: (action: FeishuIncomingCardAction) => Promise<FeishuOutgoingReply>,
  ): Promise<void> {
    this.botOpenId = await this.resolveBotOpenId();
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
            messageId: message.message_id,
            text,
            wasMentioned: message.chat_type === 'group' ? this.isMentioningBot(message) : false,
            mentionsOpenIds: message.mentions?.flatMap((mention) => (mention.id?.open_id ? [mention.id.open_id] : [])) ?? [],
            botOpenIdResolved: Boolean(this.botOpenId),
          };

          let reply: FeishuOutgoingReply;
          try {
            reply = await onMessage(incomingMessage);
          } catch (error) {
            await this.recordProcessingFailure('handle_message', incomingMessage, undefined, error);
            this.logger.error('feishu.handle_message_failed', {
              chat: incomingMessage.chatId,
              user: incomingMessage.userId,
              reason: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          await this.sendReply(message.chat_id, incomingMessage, reply);
        },
        'card.action.trigger': async (data: LarkCardActionEvent) => {
          if (!onCardAction) {
            return;
          }

          const event = data.event;
          const userId = event?.operator?.open_id;
          if (!userId) {
            return;
          }

          const parsedAction = parseCardActionValue(event?.action?.value, event?.action?.form_value);
          if (!parsedAction) {
            return;
          }

          const incomingAction: FeishuIncomingCardAction = {
            chatId: parsedAction.chatId,
            chatType: parsedAction.chatType,
            userId,
            messageId: event?.context?.open_message_id,
            action: parsedAction.action,
          };

          let reply: FeishuOutgoingReply;
          try {
            reply = await onCardAction(incomingAction);
          } catch (error) {
            await this.recordProcessingFailure('handle_message', incomingAction, undefined, error);
            this.logger.error('feishu.handle_message_failed', {
              chat: incomingAction.chatId,
              user: incomingAction.userId,
              reason: error instanceof Error ? error.message : String(error),
            });
            return;
          }

          await this.sendReply(incomingAction.chatId, incomingAction, reply);
        },
      });
    await this.wsClient.start({
      eventDispatcher: dispatcher,
    });
    this.logger.info('gateway.started', {});
  }

  private async resolveBotOpenId(): Promise<string | undefined> {
    try {
      const response = await this.client.request?.({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      });
      const botOpenId =
        typeof response === 'object' && response !== null && 'bot' in response
          ? ((response as { bot?: { open_id?: string } }).bot?.open_id ?? undefined)
          : undefined;
      if (!botOpenId) {
        await this.recordEvent?.({
          type: 'feishu.bot_identity_failed',
          at: new Date().toISOString(),
          data: {
            stage: 'resolve_bot_open_id',
            reason: 'empty_open_id',
          },
        });
        return undefined;
      }
      await this.recordEvent?.({
        type: 'feishu.bot_identity_resolved',
        at: new Date().toISOString(),
        data: {
          botOpenId,
        },
      });
      return botOpenId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.recordEvent?.({
        type: 'feishu.bot_identity_failed',
        at: new Date().toISOString(),
        data: {
          stage: 'resolve_bot_open_id',
          reason,
        },
      });
      this.logger.error('feishu.bot_identity_failed', {
        reason,
      });
      return undefined;
    }
  }

  private isMentioningBot(message: NonNullable<LarkReceiveMessageEvent['message']>): boolean {
    if (!this.botOpenId) {
      return false;
    }
    return message.mentions?.some((mention) => mention.id?.open_id === this.botOpenId) ?? false;
  }

  private async sendReply(
    chatId: string,
    message: FeishuIncomingMessage | FeishuIncomingCardAction,
    reply: FeishuOutgoingReply,
  ): Promise<void> {
    try {
      if (reply.rendered) {
        await this.sendRenderedMessage(chatId, reply.rendered);
      } else if (reply.text !== '') {
        await this.sendText(chatId, reply.text);
      }
    } catch (error) {
      await this.recordProcessingFailure('send_reply', message, reply.text, error);
      this.logger.error('feishu.send_reply_failed', {
        chat: message.chatId,
        user: message.userId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
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
    } catch (error) {
      this.logger.debug('feishu.render_fallback', {
        chat: chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
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
    message: FeishuIncomingMessage | FeishuIncomingCardAction,
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
      messageId: message.messageId,
      ...details,
    };
    if ('text' in message) {
      data.text = message.text;
    } else {
      data.action = normalizeUnknown(message.action);
    }
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
