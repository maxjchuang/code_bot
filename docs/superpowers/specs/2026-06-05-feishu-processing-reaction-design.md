# Feishu Processing Reaction Design

## Goal

When a user message has been delivered to Codex and code_bot has evidence that Codex is working on it, the bot should add Feishu's `Get` reaction to the user's original message.

This gives users a lightweight status signal without adding a chat reply for normal task acknowledgements.

## Source Notes

Feishu supports adding a message reaction with:

```text
POST /open-apis/im/v1/messages/:message_id/reactions
```

The request body uses `reaction_type.emoji_type`. Feishu's emoji text list includes `Get` as a valid value.

The caller can be a bot or user, but the caller must be in the conversation that contains the target message. The app must have robot capability enabled, and deleted or system messages cannot receive reactions.

References:

- https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create?lang=zh-CN
- https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce?lang=zh-CN

## Target Behavior

For an initial normal task message:

1. The bot sends the message text to the current Codex session.
2. The existing send-confirmation flow waits for evidence that Codex started processing.
3. If processing is confirmed, the bot adds `Get` to the user's original Feishu message.
4. If processing is not confirmed, the bot does not add a reaction.

For a follow-up message sent while an active pending Codex turn already exists:

1. The bot sends the follow-up text to the current Codex session.
2. Because Codex is already known to be working, the bot adds `Get` after `runner.send` succeeds.
3. The follow-up does not replace the original pending turn's completion notification target.

For command messages such as `/status`, `/projects`, `/tail`, `/new`, `/resume`, `/model`, `/stop`, approval commands, and card actions, the bot does not add `Get` unless the command path actually sends user text into Codex as a normal task.

If a message has no Feishu `message_id`, the bot cannot add a reaction and should continue without user-visible error.

## Architecture

Extend the Feishu outbound boundary with a narrow reaction helper:

```ts
type FeishuReactionType = 'Get' | string;

interface FeishuGateway {
  addReaction?(messageId: string, emojiType: FeishuReactionType): Promise<void>;
}
```

`LarkLongConnectionGateway.addReaction` should call the raw Feishu reaction API through the existing SDK client request facility:

```ts
POST /open-apis/im/v1/messages/{message_id}/reactions
data: {
  reaction_type: {
    emoji_type: 'Get'
  }
}
```

The `Notifier` dependency in `SessionManager` should gain the same optional `addReaction` method. This keeps reaction sending in the same dependency channel as asynchronous Feishu sends and avoids coupling `SessionManager` to the concrete gateway class.

In `SessionManager.sendToCurrentSession`, capture `input.messageId` for normal task messages. After `runner.send` succeeds:

- If the message is a follow-up to an active pending turn, add `Get` immediately.
- If this is a new pending turn and send confirmation is configured, add `Get` only after `confirmCodexStartedProcessing` returns `confirmed: true`.
- If notifications are enabled but send confirmation is not configured, add `Get` after dispatch because no stronger processing-confirmation signal exists in that mode.
- If notifications are disabled, preserve the existing synchronous acknowledgement behavior and do not add `Get`.

Keep the reaction operation best-effort. It should not change the result returned to Feishu, block completion notification delivery, or mark the Codex session failed.

## Error Handling

Reaction failures should be logged and recorded as bot events, but should not fail the user task.

Record enough context to debug permission and target issues:

- Feishu message id.
- Chat id.
- Session id when available.
- Emoji type.
- Error message.

Expected non-fatal failures include:

- The app lacks `im:message.reactions:write_only`.
- The bot is not in the target conversation.
- The message was deleted or recalled.
- The message is a system message.
- The SDK raw request facility is unavailable in a test or alternative gateway.

Duplicate reaction behavior should rely on Feishu's API semantics. The first implementation does not need to list existing reactions before adding `Get`.

## Testing

Add gateway tests proving `addReaction('om_1', 'Get')` calls:

```text
/open-apis/im/v1/messages/om_1/reactions
```

with `method: 'POST'` and `reaction_type.emoji_type: 'Get'`.

Add session-manager tests proving:

- A first task gets `Get` only after processing confirmation succeeds.
- A first task does not get `Get` when confirmation times out.
- A follow-up message gets `Get` after `runner.send` succeeds while a pending turn is active.
- A send failure does not add `Get`.
- Missing `messageId` does not attempt a reaction.
- Reaction failure is swallowed and does not change the task reply.

Existing tests around silent normal-mode acknowledgements should continue to pass; the user-visible acknowledgement remains the reaction, not a text reply.

## Non-Goals

This change does not add configurable reaction emoji settings.

This change does not remove or replace completion notifications.

This change does not add reaction deletion or status transitions such as replacing `Get` with `DONE`.

This change does not react to command-only messages that do not submit work to Codex.
