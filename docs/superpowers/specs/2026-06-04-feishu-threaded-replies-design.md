# Feishu Threaded Replies Design

## Goal

When the bot replies in a Feishu group chat, the reply should reference the user message that triggered the bot and mention the user who triggered it so they receive a notification. When the triggering message is inside a Feishu topic/thread, the bot should reply inside that topic instead of posting a new message in the main group. This behavior applies to immediate command replies, Codex turn completion notifications, and card action replies.

## Current Behavior

The Feishu gateway currently sends outbound messages with `im.v1.message.create` and `receive_id_type: chat_id`. This posts to the chat directly and does not use the triggering message as a reply target. `FeishuIncomingMessage` already carries `messageId`, and card action events can expose an open message id, but the outbound path does not use those fields.

## Source Notes

Feishu provides a reply-message API at `POST /open-apis/im/v1/messages/:message_id/reply`. The API supports regular message content fields such as `msg_type` and `content`, and supports `reply_in_thread` to reply inside a topic/thread where supported. Reference: https://open.feishu.cn/document/server-docs/im-v1/message/reply?lang=zh-CN

Feishu text message content supports user mentions with `<at user_id="..."></at>`, where the value may be an open_id. Feishu card markdown supports user mentions with `<at id="..."></at>`. Reference: https://open.feishu.cn/document/server-docs/im-v1/message-content-description/create_json?lang=zh-CN

## Target Behavior

For a normal group message that mentions the bot, every bot response tied to that input should reply to the triggering Feishu `message_id`. The reply should use `reply_in_thread: true` so topic-capable chats keep the response in the topic/thread rather than leaking into the main group.

For group or topic replies, every bot response tied to a user trigger should mention the triggering user at the beginning of the response. Text responses should prefix `<at user_id="TRIGGER_USER_OPEN_ID"></at> `. Card responses should prefix the first markdown element with `<at id="TRIGGER_USER_OPEN_ID"></at>\n`; their text fallback should also include the text mention prefix. Private-chat replies should not add mentions.

For asynchronous Codex completion notifications, the bot should preserve the original message's reply target when the turn starts or is queued. Completion, failure, cancellation, and progress-style notifications that are tied to that turn should reply to the original user message and use topic reply behavior.

For asynchronous Codex completion notifications in group/topic contexts, the bot should mention the user who started the Codex turn. Follow-up messages sent while a pending turn is active should not overwrite the original turn's mention target.

For Feishu card action events, the bot should reply to the card message id from the action event context and mention the user who clicked the card action in group/topic contexts. This keeps interactions such as model/project selection responses near the card that triggered them. If the card was in a topic, the reply should remain in that topic.

For context-free system notifications that are not triggered by a user message or card action, the bot should keep the existing chat-level send behavior.

## Architecture

Introduce a small outbound target model, for example `FeishuReplyTarget`, with:

- `chatId`: the chat fallback target.
- `replyToMessageId`: optional Feishu message id to reply to.
- `replyInThread`: optional boolean, defaulting to true when `replyToMessageId` is present for group/chat replies.
- `mentionUserId`: optional Feishu open_id to mention at the start of group/topic replies.

The gateway should gain reply-aware send helpers that accept this target. If `replyToMessageId` is present, they call `im.v1.message.reply` or the equivalent SDK method for `POST /open-apis/im/v1/messages/:message_id/reply`. If no reply target exists, they continue using `im.v1.message.create`.

Keep the existing chat-level send helpers for compatibility and for context-free notifications. Prefer adding reply-aware methods rather than changing every notifier call site to pass overloaded string-or-object arguments.

The inbound message path should construct a reply target from `FeishuIncomingMessage.chatId` and `FeishuIncomingMessage.messageId`. For group messages, it should also include `FeishuIncomingMessage.userId` as `mentionUserId`. Private messages should not set `mentionUserId`.

The card action path should construct a reply target from the card action's `messageId` plus the chat id already available in the action context. For group card actions, it should also include the operator open_id as `mentionUserId`.

The gateway should apply mentions at the outbound boundary so command handlers and session logic do not need to manually prefix message bodies. Text sends should add the text mention prefix before sanitization and chunking. Rendered card sends should add the card markdown mention to the preferred card and add the text mention prefix to text fallbacks.

The session layer should store the reply target on each pending Codex turn, including the optional `mentionUserId`. When a turn completes or fails asynchronously, `SessionManager` should use the stored target through the notifier. This preserves reply/thread/mention behavior even when the completion arrives after the original HTTP event has returned.

## Error Handling

If a message lacks a `messageId`, fall back to the existing chat-level send.

If a message has no `mentionUserId`, send the reply without an explicit mention.

If mention markup causes Feishu to reject a message, the existing send failure handling should log the error. The fallback should not silently strip the mention and retry unless the failure happens in the reply API before chat fallback; chat fallback should preserve the same mention payload.

If the Feishu reply API fails because the source message is deleted, unsupported, inaccessible, or otherwise not replyable, log the error with the target message id and fall back to chat-level send. This prevents reply routing failures from dropping user-visible bot output.

If Feishu rejects `reply_in_thread` in a specific chat or message context, treat it like a reply API failure and fall back to chat-level send. The first implementation should not try to parse every topic-specific event shape; it should rely on the reply API and preserve the message id target.

## Testing

Add gateway tests proving that a group message with `messageId` uses the reply API instead of `message.create`, with `reply_in_thread: true`.

Add gateway tests for text and rendered/card replies. Rendered cards should be sent through the reply API when a reply target exists, and through the existing create API otherwise.

Add fallback tests proving reply API failures use the existing chat-level send path and do not drop the response.

Add card action tests proving action replies use the card action `messageId` as the reply target.

Add session-manager tests proving asynchronous turn completion notifications use the stored reply target from the original message.

Add gateway tests proving group text replies prefix a Feishu text mention for the triggering user, while private replies do not.

Add gateway tests proving rendered card replies prefix the first markdown element with a Feishu card mention and also mention the user in the text fallback path.

Add session-manager tests proving asynchronous completion notification targets preserve `mentionUserId` from the original message and do not replace it with a later follow-up message's user id.

## Non-Goals

This change does not edit or update existing Feishu cards in place.

This change does not introduce new user commands.

This change does not require fully parsing Feishu topic metadata before implementation. The target behavior is driven by the original `message_id` plus `reply_in_thread`.

## Open Risks

The exact SDK method name and response shape for Feishu reply messages must be verified during implementation against the installed SDK version. If the SDK lacks a typed helper, the implementation can use the SDK's raw request facility or a narrow adapter.

Some Feishu message types or chat configurations may not support reply/thread behavior. The fallback path is required for these cases.
