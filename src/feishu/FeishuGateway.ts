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
  threadId?: string;
  text: string;
  wasMentioned?: boolean;
  mentionsOpenIds?: string[];
  botOpenIdResolved?: boolean;
}

export type FeishuReactionType = string;

export interface FeishuReplyTarget {
  chatId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  mentionUserId?: string;
}

export interface FeishuGateway {
  start(
    onMessage: (message: FeishuIncomingMessage) => Promise<FeishuOutgoingReply>,
    onCardAction?: (action: FeishuIncomingCardAction) => Promise<FeishuOutgoingReply>,
  ): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendTextToTarget(target: FeishuReplyTarget, text: string): Promise<void>;
  sendRenderedMessage(
    chatId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
  sendRenderedMessageToTarget(
    target: FeishuReplyTarget,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
  addReaction?(messageId: string, emojiType: FeishuReactionType): Promise<void>;
}

export interface FeishuOutgoingReply {
  text: string;
  rendered?: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage };
}

interface LarkReceiveMessageEvent {
  message?: {
    message_id?: string;
    thread_id?: string;
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
      open_chat_id?: string;
      open_message_id?: string;
      open_thread_id?: string;
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
}

interface LarkClientLike {
  request?: (payload: {
    url: string;
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    data?: unknown;
    [key: string]: unknown;
  }) => Promise<unknown>;
  im: {
    v1: {
      message: {
        create: (payload: {
          params: { receive_id_type: 'chat_id' };
          data: { receive_id: string; msg_type: 'text' | 'interactive'; content: string };
        }) => Promise<unknown>;
        reply?: (payload: {
          path: { message_id: string };
          data: { msg_type: 'text' | 'interactive'; content: string; reply_in_thread?: boolean };
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
            ...(message.thread_id ? { threadId: message.thread_id } : {}),
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

          const originChatId = event?.context?.open_chat_id ?? event?.open_chat_id;
          if (!originChatId) {
            return;
          }
          if (parsedAction.chatId !== originChatId) {
            return;
          }

          const incomingAction: FeishuIncomingCardAction = {
            chatId: originChatId,
            chatType: parsedAction.chatType,
            userId,
            messageId: event?.context?.open_message_id ?? event?.open_message_id,
            ...(event?.context?.open_thread_id ? { threadId: event.context.open_thread_id } : {}),
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

          await this.sendReply(originChatId, incomingAction, reply);
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
      const target = this.replyTargetForMessage(chatId, message);
      if (reply.rendered) {
        await this.sendRenderedMessageToTarget(target, reply.rendered);
      } else if (reply.text !== '') {
        await this.sendTextToTarget(target, reply.text);
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

  private replyTargetForMessage(
    chatId: string,
    message: FeishuIncomingMessage | FeishuIncomingCardAction,
  ): FeishuReplyTarget {
    return {
      chatId,
      replyToMessageId: message.messageId,
      replyInThread: message.chatType === 'group' && message.threadId ? true : undefined,
      mentionUserId: message.chatType === 'group' ? message.userId : undefined,
    };
  }

  async sendText(chatId: string, text: string): Promise<void> {
    await this.sendTextToTarget({ chatId }, text);
  }

  async sendTextToTarget(target: FeishuReplyTarget, text: string): Promise<void> {
    const sanitizedText = sanitizeFeishuText(textWithMention(target, text));
    for (const chunk of splitFeishuMessages(sanitizedText)) {
      await this.sendPayloadToTarget(target, {
        msg_type: 'text',
        content: JSON.stringify({ text: chunk }),
      });
    }
  }

  async sendRenderedMessage(
    chatId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void> {
    await this.sendRenderedMessageToTarget({ chatId }, message);
  }

  async sendRenderedMessageToTarget(
    target: FeishuReplyTarget,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void> {
    const rendered = renderedWithMention(target, message);
    try {
      await this.sendOneToTarget(rendered.target, rendered.message.preferred);
    } catch (error) {
      this.logger.debug('feishu.render_fallback', {
        chat: target.chatId,
        reason: error instanceof Error ? error.message : String(error),
      });
      await this.sendOneToTarget(rendered.target, rendered.message.fallback);
    }
  }

  async addReaction(messageId: string, emojiType: FeishuReactionType): Promise<void> {
    if (!this.client.request) {
      throw new Error('Feishu reaction API is unavailable');
    }

    await this.client.request({
      url: `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`,
      method: 'POST',
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    });
  }

  private async sendOneToTarget(target: FeishuReplyTarget, message: RenderedFeishuMessage): Promise<void> {
    if (message.kind === 'text') {
      await this.sendTextToTarget(target, message.text);
      return;
    }

    await this.sendPayloadToTarget(target, {
      msg_type: 'interactive',
      content: JSON.stringify(message.payload),
    });
  }

  private async sendPayloadToTarget(
    target: FeishuReplyTarget,
    data: { msg_type: 'text' | 'interactive'; content: string },
  ): Promise<void> {
    if (!target.replyToMessageId) {
      await this.sendPayloadToChat(target.chatId, data);
      return;
    }

    try {
      await this.replyToMessage(target, {
        ...data,
        reply_in_thread: target.replyInThread,
      });
    } catch (error) {
      this.logger.error('feishu.reply_message_failed', {
        chat: target.chatId,
        messageId: target.replyToMessageId,
        reason: error instanceof Error ? error.message : String(error),
      });
      await this.sendPayloadToChat(target.chatId, data);
    }
  }

  private async sendPayloadToChat(
    chatId: string,
    data: { msg_type: 'text' | 'interactive'; content: string },
  ): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        ...data,
      },
    });
  }

  private async replyToMessage(
    target: FeishuReplyTarget,
    data: { msg_type: 'text' | 'interactive'; content: string; reply_in_thread?: boolean },
  ): Promise<void> {
    if (!target.replyToMessageId) {
      throw new Error('Feishu reply target message id is required');
    }

    const reply = this.client.im.v1.message.reply;
    if (reply) {
      await reply({
        path: { message_id: target.replyToMessageId },
        data,
      });
      return;
    }

    if (this.client.request) {
      await this.client.request({
        url: `/open-apis/im/v1/messages/${encodeURIComponent(target.replyToMessageId)}/reply`,
        method: 'POST',
        data,
      });
      return;
    }

    throw new Error('Feishu reply API is unavailable');
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

function textWithMention(target: FeishuReplyTarget, text: string): string {
  if (!target.mentionUserId) {
    return text;
  }
  return `<at user_id="${escapeFeishuAttribute(target.mentionUserId)}"></at> ${text}`;
}

function renderedWithMention(
  target: FeishuReplyTarget,
  message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
): { target: FeishuReplyTarget; message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } } {
  if (!target.mentionUserId) {
    return { target, message };
  }

  return {
    target: { ...target, mentionUserId: undefined },
    message: {
      preferred: renderedMessageWithMention(message.preferred, target.mentionUserId),
      fallback: renderedMessageWithMention(message.fallback, target.mentionUserId),
    },
  };
}

function renderedMessageWithMention(message: RenderedFeishuMessage, userId: string): RenderedFeishuMessage {
  if (message.kind === 'text') {
    return { kind: 'text', text: textWithMention({ chatId: '', mentionUserId: userId }, message.text) };
  }
  return { kind: 'card', payload: mentionCardMarkdown(message.payload, userId) };
}

function mentionCardMarkdown(payload: Record<string, unknown>, userId: string): Record<string, unknown> {
  const clone = cloneJsonObject(payload);
  const mention = `<at id="${escapeFeishuAttribute(userId)}"></at>\n`;
  prefixFirstMarkdownElement(clone, mention);
  return clone;
}

function prefixFirstMarkdownElement(value: unknown, prefix: string): boolean {
  if (Array.isArray(value)) {
    for (const item of value) {
      if (prefixFirstMarkdownElement(item, prefix)) {
        return true;
      }
    }
    return false;
  }

  if (!isRecord(value)) {
    return false;
  }

  if (value.tag === 'markdown' && typeof value.content === 'string') {
    value.content = `${prefix}${value.content}`;
    return true;
  }

  for (const child of Object.values(value)) {
    if (prefixFirstMarkdownElement(child, prefix)) {
      return true;
    }
  }
  return false;
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return cloneJsonValue(value) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item));
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = cloneJsonValue(entry);
    }
    return result;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeFeishuAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
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
