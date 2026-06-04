# Feishu Processing Reaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Feishu's `Get` reaction to user task messages only after code_bot has sent them to Codex and has evidence Codex is working.

**Architecture:** Add a narrow optional `addReaction(messageId, emojiType)` method to the Feishu gateway and notifier boundary. `SessionManager` calls it from the existing normal-task send path: after processing confirmation for first turns, immediately after successful dispatch for follow-up messages, and never for unconfirmed sends or command-only paths. Reaction failures are recorded but remain non-fatal.

**Tech Stack:** TypeScript, Vitest, `@larksuiteoapi/node-sdk`, existing `FeishuGateway`, `SessionManager`, `FileStateStore`, and fake test harnesses.

---

## File Structure

- Modify `src/feishu/FeishuGateway.ts`: add optional `addReaction` to `FeishuGateway`, implement `LarkLongConnectionGateway.addReaction`, and record/log reaction failures at the caller layer.
- Modify `src/session/SessionManager.ts`: add optional `addReaction` to `Notifier`, add a helper that best-effort reacts to incoming Feishu message ids, and call it from the confirmed task and follow-up branches.
- Modify `tests/feishu/FeishuGateway.test.ts`: extend the gateway harness to capture raw client requests and test the reaction API payload.
- Modify `tests/session/SessionManager.test.ts`: add notifier reaction spies and tests for confirmed, unconfirmed, follow-up, send-failure, missing-message-id, and reaction-failure behavior.

---

### Task 1: Feishu Gateway Reaction API

**Files:**
- Modify: `src/feishu/FeishuGateway.ts`
- Test: `tests/feishu/FeishuGateway.test.ts`

- [ ] **Step 1: Write the failing gateway test**

In `tests/feishu/FeishuGateway.test.ts`, update `createGatewayHarness()` so the fake client request records all non-bot-info requests:

```ts
const requests: Array<{ url: string; method: string; data?: unknown }> = [];

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
```

Return `requests` from the harness:

```ts
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
};
```

Add this test:

```ts
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
```

- [ ] **Step 2: Run the gateway test and verify it fails**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts
```

Expected: FAIL with a TypeScript or runtime error because `addReaction` is not defined on `LarkLongConnectionGateway`.

- [ ] **Step 3: Implement `addReaction` in the gateway**

In `src/feishu/FeishuGateway.ts`, add a reaction type near the inbound interfaces:

```ts
export type FeishuReactionType = 'Get' | string;
```

Extend `FeishuGateway`:

```ts
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
  addReaction(messageId: string, emojiType: FeishuReactionType): Promise<void>;
}
```

Extend `LarkClientLike.request` so `data` is accepted:

```ts
request?: (payload: {
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  data?: unknown;
  [key: string]: unknown;
}) => Promise<unknown>;
```

Add this method to `LarkLongConnectionGateway`:

```ts
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
```

- [ ] **Step 4: Run the gateway test and verify it passes**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts
```

Expected: PASS for all gateway tests.

- [ ] **Step 5: Commit gateway reaction support**

Run:

```bash
git add src/feishu/FeishuGateway.ts tests/feishu/FeishuGateway.test.ts
git commit -m "feat: add feishu reaction gateway"
```

Expected: commit succeeds with only gateway and gateway-test changes.

---

### Task 2: Session Reaction Triggering

**Files:**
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing session tests for confirmed and unconfirmed first turns**

Add a helper near the top of `tests/session/SessionManager.test.ts`:

```ts
function createNotifierWithReactions() {
  return {
    sendText: vi.fn().mockResolvedValue(undefined),
    sendRenderedMessage: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(undefined),
  };
}
```

Add this test:

```ts
it('adds Get reaction after processing confirmation succeeds for a first task', async () => {
  vi.useFakeTimers();
  try {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = createNotifierWithReactions();
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      notifier,
      codexObservationStore: observationStore,
      sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, pollIntervalMs: 1 },
    } as any);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3601';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

    const pendingReply = manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      messageId: 'om_task_1',
      text: 'inspect status',
    });
    await vi.advanceTimersByTimeAsync(1);
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'running',
      latestCommentary: '我先检查当前状态。',
      latestActivityAt: '2099-01-01T00:00:00.000Z',
      recentToolEvents: [],
    });
    await vi.advanceTimersByTimeAsync(1);

    await expect(pendingReply).resolves.toEqual({ reply: '' });
    expect(notifier.addReaction).toHaveBeenCalledWith('om_task_1', 'Get');
  } finally {
    vi.useRealTimers();
  }
});
```

Add this test:

```ts
it('does not add Get reaction when first task processing is unconfirmed', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = createNotifierWithReactions();
  const observationStore = new FakeCodexObservationStore();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    notifier,
    codexObservationStore: observationStore,
    sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, sleep: async () => undefined },
  } as any);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  await store.updateSession(sessionId, (latest) => ({
    ...latest,
    codexSessionId: '019e86b4-12ed-7731-9639-c128626a3602',
  }));

  const sent = await manager.handleText({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    messageId: 'om_task_2',
    text: 'inspect status',
  });

  expect(sent.reply).toBe('');
  expect(notifier.addReaction).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write failing session tests for follow-up, send failure, missing id, and reaction failure**

Add this test:

```ts
it('adds Get reaction for a follow-up after successful dispatch while Codex is active', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = createNotifierWithReactions();
  const observationStore = new FakeCodexObservationStore();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    notifier,
    codexObservationStore: observationStore,
    sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, sleep: async () => undefined },
  } as any);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  await store.updateSession(sessionId, (latest) => ({
    ...latest,
    codexSessionId: '019e86b4-12ed-7731-9639-c128626a3603',
  }));

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', messageId: 'om_first', text: 'first task' });
  const followUp = await manager.handleText({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    messageId: 'om_followup',
    text: '补充约束',
  });

  expect(followUp.reply).toBe('');
  expect(notifier.addReaction).toHaveBeenCalledTimes(1);
  expect(notifier.addReaction).toHaveBeenCalledWith('om_followup', 'Get');
});
```

Add this test:

```ts
it('does not add Get reaction when sending to Codex fails', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = createNotifierWithReactions();
  runner.send = vi.fn(async () => {
    throw new Error('transport down');
  });
  const manager = new SessionManager(singleProjectConfig(root), store, runner, { notifier });

  const result = await manager.handleText({
    chatId: 'oc_1',
    chatType: 'private',
    userId: 'ou_1',
    messageId: 'om_failed',
    text: 'inspect status',
  });

  expect(result.reply).toBe('No running session. Run /new <project> first.');
  expect(notifier.addReaction).not.toHaveBeenCalled();
});
```

Add this test:

```ts
it('does not attempt Get reaction when incoming message id is missing', async () => {
  vi.useFakeTimers();
  try {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = createNotifierWithReactions();
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      notifier,
      codexObservationStore: observationStore,
      sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, pollIntervalMs: 1 },
    } as any);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3604';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

    const pendingReply = manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });
    await vi.advanceTimersByTimeAsync(1);
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'running',
      latestCommentary: '我先检查当前状态。',
      latestActivityAt: '2099-01-01T00:00:00.000Z',
      recentToolEvents: [],
    });
    await vi.advanceTimersByTimeAsync(1);

    await expect(pendingReply).resolves.toEqual({ reply: '' });
    expect(notifier.addReaction).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
```

Add this test:

```ts
it('swallows Get reaction failures and preserves task reply', async () => {
  vi.useFakeTimers();
  try {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = createNotifierWithReactions();
    notifier.addReaction.mockRejectedValue(new Error('missing reaction permission'));
    const observationStore = new FakeCodexObservationStore();
    const manager = new SessionManager(sampleConfig(root), store, runner, {
      notifier,
      codexObservationStore: observationStore,
      sendConfirmation: { initialWaitMs: 1, retryWaitMs: 1, pollIntervalMs: 1 },
    } as any);

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3605';
    await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));

    const pendingReply = manager.handleText({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      messageId: 'om_reaction_fails',
      text: 'inspect status',
    });
    await vi.advanceTimersByTimeAsync(1);
    observationStore.snapshots.set(codexSessionId, {
      availability: { kind: 'ready' },
      codexSessionId,
      status: 'running',
      latestCommentary: '我先检查当前状态。',
      latestActivityAt: '2099-01-01T00:00:00.000Z',
      recentToolEvents: [],
    });
    await vi.advanceTimersByTimeAsync(1);

    await expect(pendingReply).resolves.toEqual({ reply: '' });
    const day = new Date().toISOString().slice(0, 10);
    const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
    expect(content).toContain('"type":"feishu.reaction_failed"');
    expect(content).toContain('"messageId":"om_reaction_fails"');
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 3: Run the session tests and verify they fail**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: FAIL because `Notifier` has no `addReaction` and `SessionManager` never calls it.

- [ ] **Step 4: Implement session reaction triggering**

In `src/session/SessionManager.ts`, update the import:

```ts
import type { FeishuReactionType, FeishuReplyTarget } from '../feishu/FeishuGateway.js';
```

Extend `Notifier`:

```ts
export interface Notifier {
  sendText(chatId: string, text: string): Promise<void>;
  sendTextToTarget?(target: FeishuReplyTarget, text: string): Promise<void>;
  sendRenderedMessage?(
    chatId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
  sendRenderedMessageToTarget?(
    target: FeishuReplyTarget,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
  addReaction?(messageId: string, emojiType: FeishuReactionType): Promise<void>;
}
```

Add a constant near the other constants:

```ts
const CODEX_PROCESSING_REACTION: FeishuReactionType = 'Get';
```

In `sendToCurrentSession`, after `session.send_dispatched` is recorded and before the `notificationEnabled` reply branches, add a local reaction helper flag:

```ts
const shouldReactToFollowUp = notificationEnabled && followUpToActiveTurn;
if (shouldReactToFollowUp) {
  await this.addProcessingReaction({
    messageId: input.messageId,
    chatId: input.chatId,
    sessionId: chat.currentSessionId,
    projectId: session.projectId,
  });
}
```

Then replace the confirmed first-turn branch:

```ts
if (createdPendingTurn && this.deps.sendConfirmation) {
  const confirmation = await this.confirmCodexStartedProcessing(chat.currentSessionId);
  if (!confirmation.confirmed) {
    return { reply: this.isDebugUi() ? `消息已写入会话，但 3 秒内尚未确认 Codex 开始处理。可稍后用 /tail 查看。\nsession: ${chat.currentSessionId}` : '' };
  }
  await this.addProcessingReaction({
    messageId: input.messageId,
    chatId: input.chatId,
    sessionId: chat.currentSessionId,
    projectId: session.projectId,
  });
}
```

For the notifications-enabled/no-send-confirmation path, add:

```ts
if (createdPendingTurn && !this.deps.sendConfirmation) {
  await this.addProcessingReaction({
    messageId: input.messageId,
    chatId: input.chatId,
    sessionId: chat.currentSessionId,
    projectId: session.projectId,
  });
}
```

Add this private helper near `recordBackgroundError` or the send-confirmation helpers:

```ts
private async addProcessingReaction(input: {
  messageId?: string;
  chatId: string;
  sessionId: string;
  projectId: string;
}): Promise<void> {
  if (!input.messageId || !this.deps.notifier?.addReaction) {
    return;
  }

  try {
    await this.deps.notifier.addReaction(input.messageId, CODEX_PROCESSING_REACTION);
  } catch (error) {
    await this.store.appendEvent({
      type: 'feishu.reaction_failed',
      at: new Date().toISOString(),
      data: {
        messageId: input.messageId,
        chatId: input.chatId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        emojiType: CODEX_PROCESSING_REACTION,
        reason: error instanceof Error ? error.message : String(error),
      },
    }).catch((persistError) =>
      this.recordBackgroundError('feishu.reaction_failed_persist_failed', persistError, {
        messageId: input.messageId,
        chatId: input.chatId,
        sessionId: input.sessionId,
        projectId: input.projectId,
        emojiType: CODEX_PROCESSING_REACTION,
      }).catch(() => undefined),
    );
    this.logger.error('feishu.reaction_failed', {
      chat: input.chatId,
      session: input.sessionId,
      messageId: input.messageId,
      emojiType: CODEX_PROCESSING_REACTION,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
```

- [ ] **Step 5: Run the session tests and verify they pass**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: PASS for all session-manager tests.

- [ ] **Step 6: Commit session reaction triggering**

Run:

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: react when codex starts processing"
```

Expected: commit succeeds with only session-manager and session test changes.

---

### Task 3: Full Verification

**Files:**
- Verify: `src/feishu/FeishuGateway.ts`
- Verify: `src/session/SessionManager.ts`
- Verify: `tests/feishu/FeishuGateway.test.ts`
- Verify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts tests/session/SessionManager.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run the full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Type-check the project**

Run:

```bash
npm run typecheck
```

Expected: PASS. If `package.json` has no `typecheck` script, run:

```bash
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git status --short
git diff --stat
git diff -- src/feishu/FeishuGateway.ts src/session/SessionManager.ts tests/feishu/FeishuGateway.test.ts tests/session/SessionManager.test.ts
```

Expected: only intended reaction-related source and test changes are present.

- [ ] **Step 5: Commit any verification fixes**

If verification required fixes, commit them:

```bash
git add src/feishu/FeishuGateway.ts src/session/SessionManager.ts tests/feishu/FeishuGateway.test.ts tests/session/SessionManager.test.ts
git commit -m "test: cover feishu processing reaction"
```

Expected: commit succeeds if there are remaining changes. If there are no changes after Task 1 and Task 2 commits, skip this commit.

---

## Self-Review Notes

- Spec coverage: Task 1 covers the Feishu reaction API. Task 2 covers confirmed first turns, unconfirmed first turns, follow-up turns, missing message ids, send failures, and non-fatal reaction failures. Task 3 covers focused and full verification.
- Type consistency: the plan uses `FeishuReactionType`, `FeishuGateway.addReaction`, and `Notifier.addReaction` consistently across gateway and session code.
- Scope: the plan intentionally does not add configuration, reaction deletion, or status-transition reactions.
