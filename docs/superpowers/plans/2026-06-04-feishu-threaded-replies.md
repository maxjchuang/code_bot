# Feishu Threaded Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Feishu bot replies through the original message id so group replies quote the triggering message, mention the triggering user, and topic replies stay inside the topic/thread.

**Architecture:** Add a small reply-target type shared by the Feishu gateway and session notifier. The gateway chooses Feishu reply API when a `replyToMessageId` exists and falls back to the current chat-level create API on missing target or reply failure. The gateway applies Feishu mention markup at the outbound boundary when `mentionUserId` is present. The session layer stores the reply target on pending Codex turns so asynchronous completion notifications use the original message context.

**Tech Stack:** TypeScript, Vitest, `@larksuiteoapi/node-sdk`, existing Feishu gateway/session manager abstractions.

---

## File Structure

- Modify `src/feishu/FeishuGateway.ts`: add `FeishuReplyTarget`, reply-aware send methods, reply API adapter, fallback behavior, send-reply routing, and outbound mention formatting.
- Modify `src/session/SessionManager.ts`: add optional `messageId` to `IncomingBotText`, add `NotifierReplyTarget`, store reply target on `PendingTurn`, and use reply-aware notifier methods for completion notifications including mention targets.
- Modify `src/index.ts`: no direct behavior change expected after gateway-driven immediate replies, but keep logging/data flow compatible with `messageId`.
- Modify `tests/feishu/FeishuGateway.test.ts`: add reply API harness support and tests for inbound text replies, rendered replies, card actions, mentions, chunking, and fallback.
- Modify `tests/session/SessionManager.test.ts`: add tests that pending Codex completion notifications pass the stored reply target and mention target to the notifier.
- Modify `tests/app/bootstrap.test.ts` and `tests/app/createApp.test.ts` only if TypeScript interface changes require mock notifier updates.

## Task 1: Add Gateway Reply API Routing

**Files:**
- Modify: `src/feishu/FeishuGateway.ts`
- Test: `tests/feishu/FeishuGateway.test.ts`

- [ ] **Step 1: Write failing gateway tests for text replies**

Add reply tracking to `createGatewayHarness()` in `tests/feishu/FeishuGateway.test.ts`:

```ts
const replies: Array<{ message_id: string; msg_type: string; content: string; reply_in_thread?: boolean }> = [];
```

Extend the fake `message` client with a `reply` method:

```ts
reply: async ({ path, data }) => {
  replies.push({
    message_id: path.message_id,
    msg_type: data.msg_type,
    content: data.content,
    reply_in_thread: data.reply_in_thread,
  });
},
```

Return `replies` from the harness.

Update `handles text event and sends onMessage reply to original chat` so the incoming event contains `message_id: 'om_123'` and assert:

```ts
expect(harness.sent).toEqual([]);
expect(harness.replies).toEqual([
  {
    message_id: 'om_123',
    msg_type: 'text',
    content: JSON.stringify({ text: 'bot reply' }),
    reply_in_thread: true,
  },
]);
```

Add a separate fallback test for events without `message_id`:

```ts
it('falls back to chat send when an incoming reply target has no message id', async () => {
  const harness = createGatewayHarness();
  await harness.gateway.start(async () => ({ text: 'bot reply' }));

  await harness.getHandler()({
    message: {
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
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
```

- [ ] **Step 2: Run failing gateway tests**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts
```

Expected: FAIL because `reply` is not in `LarkClientLike`, `createGatewayHarness` is not wired, and gateway still calls `message.create`.

- [ ] **Step 3: Implement minimal reply target support**

In `src/feishu/FeishuGateway.ts`, export a target type near `FeishuIncomingMessage`:

```ts
export interface FeishuReplyTarget {
  chatId: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
}
```

Extend `FeishuGateway`:

```ts
sendTextToTarget(target: FeishuReplyTarget, text: string): Promise<void>;
sendRenderedMessageToTarget(
  target: FeishuReplyTarget,
  message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
): Promise<void>;
```

Extend `LarkClientLike.im.v1.message`:

```ts
reply?: (payload: {
  path: { message_id: string };
  data: { msg_type: 'text' | 'interactive'; content: string; reply_in_thread?: boolean };
}) => Promise<unknown>;
```

Replace `sendReply()` routing with a target:

```ts
const target = this.replyTargetForMessage(chatId, message);
if (reply.rendered) {
  await this.sendRenderedMessageToTarget(target, reply.rendered);
} else if (reply.text !== '') {
  await this.sendTextToTarget(target, reply.text);
}
```

Add helper:

```ts
private replyTargetForMessage(chatId: string, message: FeishuIncomingMessage | FeishuIncomingCardAction): FeishuReplyTarget {
  return {
    chatId,
    replyToMessageId: message.messageId,
    replyInThread: message.messageId ? true : undefined,
  };
}
```

Add reply-aware text send:

```ts
async sendTextToTarget(target: FeishuReplyTarget, text: string): Promise<void> {
  const sanitizedText = sanitizeFeishuText(text);
  for (const chunk of splitFeishuMessages(sanitizedText)) {
    await this.sendPayloadToTarget(target, 'text', JSON.stringify({ text: chunk }));
  }
}
```

Add shared payload send with fallback:

```ts
private async sendPayloadToTarget(
  target: FeishuReplyTarget,
  msgType: 'text' | 'interactive',
  content: string,
): Promise<void> {
  if (!target.replyToMessageId) {
    await this.sendPayloadToChat(target.chatId, msgType, content);
    return;
  }
  try {
    await this.replyToMessage(target, msgType, content);
  } catch (error) {
    this.logger.error('feishu.reply_message_failed', {
      chat: target.chatId,
      messageId: target.replyToMessageId,
      reason: error instanceof Error ? error.message : String(error),
    });
    await this.sendPayloadToChat(target.chatId, msgType, content);
  }
}
```

Add helpers:

```ts
private async sendPayloadToChat(chatId: string, msgType: 'text' | 'interactive', content: string): Promise<void> {
  await this.client.im.v1.message.create({
    params: { receive_id_type: 'chat_id' },
    data: {
      receive_id: chatId,
      msg_type: msgType,
      content,
    },
  });
}

private async replyToMessage(target: FeishuReplyTarget, msgType: 'text' | 'interactive', content: string): Promise<void> {
  const payload = {
    path: { message_id: target.replyToMessageId! },
    data: {
      msg_type: msgType,
      content,
      reply_in_thread: target.replyInThread ?? true,
    },
  };
  if (this.client.im.v1.message.reply) {
    await this.client.im.v1.message.reply(payload);
    return;
  }
  if (this.client.request) {
    await this.client.request({
      url: `/open-apis/im/v1/messages/${encodeURIComponent(target.replyToMessageId!)}/reply`,
      method: 'POST',
      data: payload.data,
    });
    return;
  }
  throw new Error('Feishu reply API is unavailable');
}
```

Rewrite existing `sendText()` to delegate:

```ts
async sendText(chatId: string, text: string): Promise<void> {
  await this.sendTextToTarget({ chatId }, text);
}
```

- [ ] **Step 4: Run gateway tests**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts
```

Expected: PASS for the new text reply tests and existing sendText/chat-send tests.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/feishu/FeishuGateway.ts tests/feishu/FeishuGateway.test.ts
git commit -m "feat: reply to feishu source messages"
```

## Task 2: Support Reply-Aware Rendered Messages and Card Actions

**Files:**
- Modify: `src/feishu/FeishuGateway.ts`
- Test: `tests/feishu/FeishuGateway.test.ts`

- [ ] **Step 1: Write failing tests for rendered/card reply targets**

Add a test for direct rendered target sending:

```ts
it('sends rendered card messages through the reply API when a reply target exists', async () => {
  const harness = createGatewayHarness();

  await harness.gateway.sendRenderedMessageToTarget(
    { chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true },
    {
      preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
      fallback: { kind: 'text', text: 'fallback' },
    },
  );

  expect(harness.sent).toEqual([]);
  expect(harness.replies).toEqual([
    {
      message_id: 'om_123',
      msg_type: 'interactive',
      content: JSON.stringify({ schema: '2.0', body: { elements: [] } }),
      reply_in_thread: true,
    },
  ]);
});
```

Update the card action routing tests so `model updated` and `project updated` are expected in `harness.replies` with `message_id: 'om_card_1'` instead of `harness.sent`.

Add a reply API failure fallback test:

```ts
it('falls back to chat send when the reply API rejects', async () => {
  const sent: Array<{ receive_id: string; msg_type: string; content: string }> = [];
  const errors: unknown[][] = [];
  const gateway = new LarkLongConnectionGateway('app', 'secret', {
    client: {
      im: {
        v1: {
          message: {
            reply: async () => {
              throw new Error('reply unsupported');
            },
            create: async ({ data }) => {
              sent.push({ receive_id: data.receive_id, msg_type: data.msg_type, content: data.content });
            },
          },
        },
      },
    },
    logger: {
      error: (...args: unknown[]) => errors.push(args),
    },
  } as any);

  await gateway.sendTextToTarget({ chatId: 'oc_1', replyToMessageId: 'om_123', replyInThread: true }, 'fallback text');

  expect(sent).toEqual([
    { receive_id: 'oc_1', msg_type: 'text', content: JSON.stringify({ text: 'fallback text' }) },
  ]);
  expect(errors).toContainEqual([
    'feishu.reply_message_failed',
    expect.objectContaining({ chat: 'oc_1', messageId: 'om_123', reason: 'reply unsupported' }),
  ]);
});
```

- [ ] **Step 2: Run failing gateway tests**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts
```

Expected: FAIL because rendered target sending and card action assertions are not implemented yet.

- [ ] **Step 3: Implement rendered target support**

In `src/feishu/FeishuGateway.ts`, implement:

```ts
async sendRenderedMessageToTarget(
  target: FeishuReplyTarget,
  message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
): Promise<void> {
  try {
    await this.sendOneToTarget(target, message.preferred);
  } catch (error) {
    this.logger.debug('feishu.render_fallback', {
      chat: target.chatId,
      reason: error instanceof Error ? error.message : String(error),
    });
    await this.sendOneToTarget(target, message.fallback);
  }
}

async sendRenderedMessage(
  chatId: string,
  message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
): Promise<void> {
  await this.sendRenderedMessageToTarget({ chatId }, message);
}

private async sendOneToTarget(target: FeishuReplyTarget, message: RenderedFeishuMessage): Promise<void> {
  if (message.kind === 'text') {
    await this.sendTextToTarget(target, message.text);
    return;
  }
  await this.sendPayloadToTarget(target, 'interactive', JSON.stringify(message.payload));
}
```

Remove or replace the old `sendOne(chatId, message)` helper so all rendered paths use `sendOneToTarget()`.

- [ ] **Step 4: Run gateway tests**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/feishu/FeishuGateway.ts tests/feishu/FeishuGateway.test.ts
git commit -m "feat: reply with feishu rendered messages"
```

## Task 3: Preserve Reply Targets for Async Codex Notifications

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify if needed: `tests/app/bootstrap.test.ts`
- Modify if needed: `tests/app/createApp.test.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing session-manager test**

In `tests/session/SessionManager.test.ts`, add or update a completion-notification test where the inbound input includes a message id:

```ts
const notifier = {
  sendText: vi.fn().mockResolvedValue(undefined),
  sendTextToTarget: vi.fn().mockResolvedValue(undefined),
  sendRenderedMessage: vi.fn().mockResolvedValue(undefined),
  sendRenderedMessageToTarget: vi.fn().mockResolvedValue(undefined),
};

await manager.handleText({
  chatId: 'oc_1',
  chatType: 'group',
  userId: 'ou_1',
  messageId: 'om_original_1',
  text: 'run tests',
  wasMentioned: true,
});
```

After the existing test setup triggers completion, assert:

```ts
await waitForAssertion(() => expect(notifier.sendRenderedMessageToTarget).toHaveBeenCalledTimes(1));
expect(notifier.sendRenderedMessageToTarget).toHaveBeenCalledWith(
  { chatId: 'oc_1', replyToMessageId: 'om_original_1', replyInThread: true },
  expect.objectContaining({
    preferred: expect.any(Object),
    fallback: expect.any(Object),
  }),
);
expect(notifier.sendRenderedMessage).not.toHaveBeenCalled();
```

Add a fallback test for notifiers without reply-aware methods:

```ts
const notifier = {
  sendText: vi.fn().mockResolvedValue(undefined),
  sendRenderedMessage: vi.fn().mockResolvedValue(undefined),
};
```

Assert the existing `sendRenderedMessage('oc_1', rendered)` behavior remains unchanged when `sendRenderedMessageToTarget` is absent.

- [ ] **Step 2: Run failing session test**

Run the targeted test file:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: FAIL because `IncomingBotText` lacks `messageId`, pending turns do not store reply targets, and completion notifications call only chat-level notifier methods.

- [ ] **Step 3: Implement session reply target propagation**

In `src/session/SessionManager.ts`, import the target type:

```ts
import type { FeishuReplyTarget } from '../feishu/FeishuGateway.js';
```

Extend `IncomingBotText`:

```ts
messageId?: string;
```

Add a local notifier target alias if importing the gateway type creates an undesirable dependency:

```ts
export type NotifierReplyTarget = FeishuReplyTarget;
```

Extend `Notifier`:

```ts
sendTextToTarget?(target: FeishuReplyTarget, text: string): Promise<void>;
sendRenderedMessageToTarget?(
  target: FeishuReplyTarget,
  message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
): Promise<void>;
```

Extend `PendingTurn`:

```ts
replyTarget?: FeishuReplyTarget;
```

Add helper:

```ts
private replyTargetForInput(input: IncomingBotText): FeishuReplyTarget | undefined {
  if (!input.messageId) {
    return undefined;
  }
  return {
    chatId: input.chatId,
    replyToMessageId: input.messageId,
    replyInThread: true,
  };
}
```

Change pending turn creation call in `sendToCurrentSession()`:

```ts
const turn = this.createPendingTurn(
  chat.currentSessionId,
  input.chatId,
  session.projectId,
  text,
  notificationStartedAt,
  this.replyTargetForInput(input),
);
```

Change `createPendingTurn()` signature and return value:

```ts
private createPendingTurn(
  sessionId: string,
  chatId: string,
  projectId: string,
  prompt: string,
  startedAt: string,
  replyTarget?: FeishuReplyTarget,
): PendingTurn {
  return {
    id: `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    sessionId,
    chatId,
    projectId,
    prompt,
    startedAt,
    replyTarget,
    notified: false,
    candidateUpdateCount: 0,
    submitRetryCount: 0,
    processingState: 'pending_confirmation',
  };
}
```

Add notifier helpers:

```ts
private async sendRenderedNotification(turn: PendingTurn, rendered: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage }): Promise<void> {
  const notifier = this.deps.notifier!;
  if (turn.replyTarget && notifier.sendRenderedMessageToTarget) {
    await notifier.sendRenderedMessageToTarget(turn.replyTarget, rendered);
    return;
  }
  if (notifier.sendRenderedMessage) {
    await notifier.sendRenderedMessage(turn.chatId, rendered);
    return;
  }
  const fallbackText = rendered.fallback.kind === 'text' ? rendered.fallback.text : undefined;
  await this.sendTextNotification(turn, fallbackText ?? '');
}

private async sendTextNotification(turn: PendingTurn, text: string): Promise<void> {
  const notifier = this.deps.notifier!;
  if (turn.replyTarget && notifier.sendTextToTarget) {
    await notifier.sendTextToTarget(turn.replyTarget, text);
    return;
  }
  await notifier.sendText(turn.chatId, text);
}
```

Replace the direct notifier calls in `completePendingTurn()` with:

```ts
if (this.deps.notifier!.sendRenderedMessage || this.deps.notifier!.sendRenderedMessageToTarget) {
  await this.sendRenderedNotification(turn, rendered);
} else {
  await this.sendTextNotification(
    turn,
    rendered.fallback.kind === 'text' ? rendered.fallback.text : message.fallbackText,
  );
}
```

- [ ] **Step 4: Update app/bootstrap notifier mocks if TypeScript requires it**

If `npm test` or `npm run build` reports mock type errors, update only the affected mocks in `tests/app/bootstrap.test.ts` and `tests/app/createApp.test.ts` by adding no-op reply-aware methods:

```ts
sendTextToTarget: async () => undefined,
sendRenderedMessageToTarget: async () => undefined,
```

Do not change runtime behavior in `src/index.ts`; the gateway already receives full inbound messages and owns immediate reply routing.

- [ ] **Step 5: Run session tests**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts tests/app/bootstrap.test.ts tests/app/createApp.test.ts
git commit -m "feat: preserve feishu reply targets for notifications"
```

If the app test files were not changed, omit them from `git add`.

## Task 5: Mention Triggering Users in Group and Topic Replies

**Files:**
- Modify: `src/feishu/FeishuGateway.ts`
- Modify: `src/session/SessionManager.ts`
- Test: `tests/feishu/FeishuGateway.test.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing gateway tests for group text mentions**

In `tests/feishu/FeishuGateway.test.ts`, add this group reply test:

```ts
it('mentions the triggering user when replying to group text messages', async () => {
  const harness = createGatewayHarness();
  await harness.gateway.start(async () => ({ text: 'bot reply' }));

  await harness.getHandler()({
    message: {
      message_id: 'om_mention_1',
      chat_id: 'oc_1',
      chat_type: 'group',
      message_type: 'text',
      content: JSON.stringify({ text: '@_user_1 hello bot' }),
      mentions: [{ id: { open_id: 'ou_bot' } }],
    },
    sender: { sender_id: { open_id: 'ou_trigger' } },
  });

  expect(harness.replies).toEqual([
    {
      message_id: 'om_mention_1',
      msg_type: 'text',
      content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> bot reply' }),
      reply_in_thread: true,
    },
  ]);
});
```

Add this private-chat guard test:

```ts
it('does not mention users when replying to private messages', async () => {
  const harness = createGatewayHarness();
  await harness.gateway.start(async () => ({ text: 'bot reply' }));

  await harness.getHandler()({
    message: {
      message_id: 'om_private_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello bot' }),
    },
    sender: { sender_id: { open_id: 'ou_trigger' } },
  });

  expect(harness.replies).toEqual([
    {
      message_id: 'om_private_1',
      msg_type: 'text',
      content: JSON.stringify({ text: 'bot reply' }),
      reply_in_thread: true,
    },
  ]);
});
```

- [ ] **Step 2: Write failing gateway tests for rendered card mentions**

Add this direct card mention test:

```ts
it('mentions the triggering user in rendered card markdown', async () => {
  const harness = createGatewayHarness();

  await harness.gateway.sendRenderedMessageToTarget(
    { chatId: 'oc_1', replyToMessageId: 'om_card_mention_1', replyInThread: true, mentionUserId: 'ou_trigger' },
    {
      preferred: {
        kind: 'card',
        payload: {
          schema: '2.0',
          body: {
            elements: [{ tag: 'markdown', content: '**Status**\nDone' }],
          },
        },
      },
      fallback: { kind: 'text', text: 'Done' },
    },
  );

  const cardContent = JSON.parse(harness.replies[0]!.content) as {
    body: { elements: Array<{ tag: string; content?: string }> };
  };
  expect(cardContent.body.elements[0]).toMatchObject({
    tag: 'markdown',
    content: '<at id="ou_trigger"></at>\n**Status**\nDone',
  });
});
```

Add this rendered fallback mention test:

```ts
it('mentions the triggering user in rendered text fallback after card send failure', async () => {
  const sent: Array<{ receive_id: string; msg_type: string; content: string }> = [];
  const errors: unknown[][] = [];
  const gateway = new LarkLongConnectionGateway('app', 'secret', {
    client: {
      im: {
        v1: {
          message: {
            reply: async () => {
              throw new Error('reply unsupported');
            },
            create: async ({ data }) => {
              sent.push({ receive_id: data.receive_id, msg_type: data.msg_type, content: data.content });
            },
          },
        },
      },
    },
    logger: { error: (...args: unknown[]) => errors.push(args) },
  } as any);

  await gateway.sendRenderedMessageToTarget(
    { chatId: 'oc_1', replyToMessageId: 'om_card_mention_1', replyInThread: true, mentionUserId: 'ou_trigger' },
    {
      preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
      fallback: { kind: 'text', text: 'fallback text' },
    },
  );

  expect(sent.at(-1)).toEqual({
    receive_id: 'oc_1',
    msg_type: 'text',
    content: JSON.stringify({ text: '<at user_id="ou_trigger"></at> fallback text' }),
  });
});
```

- [ ] **Step 3: Write failing session-manager test for persisted mention targets**

In `tests/session/SessionManager.test.ts`, add a completion notification test where a follow-up message arrives from a different user before completion. Use the existing async completion test setup helpers around the current reply-target tests, then assert:

```ts
expect(notifier.sendRenderedMessageToTarget).toHaveBeenCalledWith(
  { chatId: 'oc_1', replyToMessageId: 'om_original_1', replyInThread: true, mentionUserId: 'ou_original' },
  expect.objectContaining({ preferred: expect.any(Object), fallback: expect.any(Object) }),
);
```

The test input sequence must include:

```ts
await manager.handleText({
  chatId: 'oc_1',
  chatType: 'group',
  userId: 'ou_original',
  messageId: 'om_original_1',
  text: 'run tests',
  wasMentioned: true,
});

await manager.handleText({
  chatId: 'oc_1',
  chatType: 'group',
  userId: 'ou_followup',
  messageId: 'om_followup_1',
  text: 'also check lint',
  wasMentioned: true,
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts tests/session/SessionManager.test.ts
```

Expected: FAIL because `FeishuReplyTarget` lacks `mentionUserId`, gateway targets do not set it, gateway send paths do not apply mention markup, and session pending turns do not preserve it.

- [ ] **Step 5: Implement mention target propagation**

In `src/feishu/FeishuGateway.ts`, extend `FeishuReplyTarget`:

```ts
mentionUserId?: string;
```

Update `replyTargetForMessage()`:

```ts
private replyTargetForMessage(
  chatId: string,
  message: FeishuIncomingMessage | FeishuIncomingCardAction,
): FeishuReplyTarget {
  const mentionUserId = message.chatType === 'group' ? message.userId : undefined;
  return {
    chatId,
    replyToMessageId: message.messageId,
    replyInThread: message.messageId ? true : undefined,
    mentionUserId,
  };
}
```

In `src/session/SessionManager.ts`, include `mentionUserId` when creating a pending-turn target:

```ts
const replyTarget = input.messageId
  ? {
      chatId: input.chatId,
      replyToMessageId: input.messageId,
      replyInThread: true,
      mentionUserId: input.chatType === 'group' ? input.userId : undefined,
    }
  : undefined;
```

- [ ] **Step 6: Implement mention formatting at the gateway boundary**

In `src/feishu/FeishuGateway.ts`, add helpers:

```ts
private textWithMention(target: FeishuReplyTarget, text: string): string {
  if (!target.mentionUserId) {
    return text;
  }
  return `<at user_id="${escapeFeishuAttribute(target.mentionUserId)}"></at> ${text}`;
}

private renderedWithMention(target: FeishuReplyTarget, message: RenderedFeishuMessage): RenderedFeishuMessage {
  if (!target.mentionUserId) {
    return message;
  }
  if (message.kind === 'text') {
    return { kind: 'text', text: this.textWithMention(target, message.text) };
  }
  return { kind: 'card', payload: mentionCardMarkdown(message.payload, target.mentionUserId) };
}
```

Add pure helpers near the bottom of the file:

```ts
function mentionCardMarkdown(payload: Record<string, unknown>, userId: string): Record<string, unknown> {
  const body = isRecord(payload.body) ? payload.body : undefined;
  const elements = Array.isArray(body?.elements) ? body.elements : undefined;
  if (!body || !elements) {
    return payload;
  }
  const index = elements.findIndex((element) => isRecord(element) && element.tag === 'markdown' && typeof element.content === 'string');
  if (index === -1) {
    return payload;
  }
  const nextElements = [...elements];
  const element = nextElements[index] as Record<string, unknown>;
  nextElements[index] = {
    ...element,
    content: `<at id="${escapeFeishuAttribute(userId)}"></at>\n${element.content}`,
  };
  return {
    ...payload,
    body: {
      ...body,
      elements: nextElements,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function escapeFeishuAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
```

Update `sendTextToTarget()`:

```ts
const sanitizedText = sanitizeFeishuText(this.textWithMention(target, text));
```

Update `sendOneToTarget()`:

```ts
const messageWithMention = this.renderedWithMention(target, message);
if (messageWithMention.kind === 'text') {
  await this.sendTextToTarget({ ...target, mentionUserId: undefined }, messageWithMention.text);
  return;
}
await this.sendPayloadToTarget(target, {
  msg_type: 'interactive',
  content: JSON.stringify(messageWithMention.payload),
});
```

Clearing `mentionUserId` when sending a text `RenderedFeishuMessage` avoids double-prefixing because `renderedWithMention()` already added the mention.

- [ ] **Step 7: Run targeted tests**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts tests/session/SessionManager.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/feishu/FeishuGateway.ts src/session/SessionManager.ts tests/feishu/FeishuGateway.test.ts tests/session/SessionManager.test.ts
git commit -m "feat: mention users in feishu threaded replies"
```

## Task 4: Full Verification and PR Update

**Files:**
- Modify: no source changes expected
- Test: full test suite and TypeScript build

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: all Vitest test files pass.

- [ ] **Step 2: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: `tsc -p tsconfig.json` exits with code 0.

- [ ] **Step 3: Inspect worktree**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: no uncommitted implementation changes. Recent commits should include the spec commit plus the implementation commits from this plan.

- [ ] **Step 4: Push branch and update PR**

If implementation is on a feature branch:

```bash
git push -u origin <branch-name>
```

If no PR exists for the branch:

```bash
gh pr create --base main --head <branch-name> --title "Support Feishu threaded replies" --body "Adds reply-target routing so group replies quote the triggering message and topic replies stay in-thread."
```

If a PR already exists:

```bash
gh pr view --json url,baseRefName,headRefName,mergeStateStatus
```

Expected: PR targets `main`; merge state is not blocked by local uncommitted changes.

## Self-Review

Spec coverage:

- Group replies quote triggering messages: Task 1 covers inbound message reply API routing.
- Topic/thread replies: Task 1 and Task 2 assert `reply_in_thread: true`.
- Async Codex notifications: Task 3 stores and uses the original message reply target.
- Card action replies: Task 2 updates card action expectations to reply to the card message id.
- Context-free notifications: Task 1 keeps `sendText(chatId, text)` and Task 2 keeps `sendRenderedMessage(chatId, message)` as chat-level sends.
- Fallback behavior: Task 1 covers missing message id; Task 2 covers reply API rejection.
- Group/topic mention behavior: Task 5 covers text mention prefix, card markdown mention prefix, rendered text fallback mention prefix, private-chat no-mention guard, and pending-turn mention persistence.

Placeholder scan:

- No `TBD`, `TODO`, `FIXME`, or vague implementation-only steps are intentionally left in this plan.

Type consistency:

- `FeishuReplyTarget`, `sendTextToTarget`, and `sendRenderedMessageToTarget` are introduced in Task 1 and reused consistently in Tasks 2, 3, and 5. `mentionUserId` is added in Task 5 and propagated through the same target type.
