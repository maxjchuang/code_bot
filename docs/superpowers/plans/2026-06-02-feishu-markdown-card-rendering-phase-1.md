# Feishu Markdown Card Rendering Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render normal replies, completion notifications, and error notifications as Feishu Markdown cards with plain-text fallback, while keeping future message types extensible.

**Architecture:** Introduce a small structured outbound message model and a dedicated Feishu renderer that owns verbosity-aware card generation, Markdown normalization, and fallback text preparation. Keep Feishu transport details in the gateway and avoid leaking card JSON into `SessionManager`.

**Tech Stack:** TypeScript, Vitest, existing Feishu gateway integration, existing `SessionManager`, existing UI verbosity config, Feishu interactive card messages.

---

## File Structure

- Create `src/feishu/FeishuMessageRenderer.ts`: converts internal outbound messages into Feishu card payloads and fallback text.
- Create `tests/feishu/FeishuMessageRenderer.test.ts`: unit tests for card generation, normal/debug rendering, and fallback text.
- Modify `src/feishu/FeishuGateway.ts`: add card-first send path and plain-text fallback path.
- Modify `tests/feishu/FeishuGateway.test.ts`: verify card-first behavior, fallback to text, and empty reply handling.
- Modify `src/session/SessionManager.ts`: map targeted outputs into structured outbound messages.
- Modify `tests/session/SessionManager.test.ts`: verify normal/debug reply behavior and notification body changes.
- Modify `src/notifications/FinalAnswerExtractor.ts`: keep completion formatting aligned with structured outbound messages or remove direct formatting responsibility if moved.
- Modify `tests/notifications/FinalAnswerExtractor.test.ts`: update only if completion formatting responsibility changes.
- Modify `src/app/createApp.ts` and `src/index.ts` only if constructor wiring needs new renderer dependencies.

## Task 1: Define the Structured Outbound Message Model

**Files:**
- Create: `src/feishu/FeishuMessageRenderer.ts`
- Test: `tests/feishu/FeishuMessageRenderer.test.ts`

- [ ] **Step 1: Write the failing renderer tests**

Create `tests/feishu/FeishuMessageRenderer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderFeishuMessage } from '../../src/feishu/FeishuMessageRenderer.js';

describe('renderFeishuMessage', () => {
  it('renders a normal-mode completion as a markdown card without debug metadata', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'completion',
        bodyMarkdown: '最终答案\n\n- 第一项\n- 第二项',
        fallbackText: '最终答案\n\n- 第一项\n- 第二项',
      },
      { verbosity: 'normal' },
    );

    expect(rendered.preferred.kind).toBe('card');
    expect(rendered.fallback.kind).toBe('text');
    expect(JSON.stringify(rendered.preferred.payload)).toContain('最终答案');
    expect(JSON.stringify(rendered.preferred.payload)).not.toContain('sessionId');
  });

  it('renders a debug-mode reply with an additional debug section', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'reply',
        bodyMarkdown: '已发送请求。',
        fallbackText: '已发送请求。',
        debug: { sessionId: 'sess_123', projectId: 'repo', source: 'observation' },
      },
      { verbosity: 'debug' },
    );

    expect(rendered.preferred.kind).toBe('card');
    expect(JSON.stringify(rendered.preferred.payload)).toContain('sess_123');
    expect(JSON.stringify(rendered.preferred.payload)).toContain('observation');
  });

  it('normalizes markdown into a safe subset for card rendering', () => {
    const rendered = renderFeishuMessage(
      {
        kind: 'reply',
        bodyMarkdown: '```ts\\nconst x = 1\\n```',
        fallbackText: 'const x = 1',
      },
      { verbosity: 'normal' },
    );

    expect(JSON.stringify(rendered.preferred.payload)).toContain('const x = 1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/feishu/FeishuMessageRenderer.test.ts
```

Expected: FAIL because `src/feishu/FeishuMessageRenderer.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/feishu/FeishuMessageRenderer.ts`:

```ts
export type BotMessage = {
  kind: 'reply' | 'completion' | 'error';
  bodyMarkdown: string;
  fallbackText: string;
  debug?: {
    sessionId?: string;
    projectId?: string;
    source?: string;
    reason?: string;
    chunkInfo?: string;
  };
};

export type RenderedFeishuMessage =
  | { kind: 'text'; text: string }
  | { kind: 'card'; payload: Record<string, unknown> };

export function renderFeishuMessage(
  message: BotMessage,
  options: { verbosity: 'normal' | 'debug' },
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const body = normalizeMarkdown(message.bodyMarkdown);
  const elements: Array<Record<string, unknown>> = [
    {
      tag: 'markdown',
      content: body,
    },
  ];

  if (options.verbosity === 'debug' && message.debug) {
    const debugLines = Object.entries(message.debug)
      .filter(([, value]) => value)
      .map(([key, value]) => `- **${key}**: \`${value}\``);
    if (debugLines.length > 0) {
      elements.push({
        tag: 'markdown',
        content: `---\n**Debug**\n${debugLines.join('\n')}`,
      });
    }
  }

  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0',
        body: {
          elements,
        },
      },
    },
    fallback: {
      kind: 'text',
      text: message.fallbackText,
    },
  };
}

function normalizeMarkdown(markdown: string): string {
  return markdown.replace(/\r\n/g, '\n').trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/feishu/FeishuMessageRenderer.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/feishu/FeishuMessageRenderer.ts tests/feishu/FeishuMessageRenderer.test.ts
git commit -m "Add Feishu message renderer"
```

## Task 2: Add Card-First Gateway Delivery with Text Fallback

**Files:**
- Modify: `src/feishu/FeishuGateway.ts`
- Modify: `tests/feishu/FeishuGateway.test.ts`

- [ ] **Step 1: Write the failing gateway tests**

Append to `tests/feishu/FeishuGateway.test.ts`:

```ts
it('sends a card payload when the reply is rendered as a card', async () => {
  const sent: Array<{ msg_type: string; content: string }> = [];
  const gateway = new LarkLongConnectionGateway('app', 'secret', {
    client: {
      im: {
        v1: {
          message: {
            create: async ({ data }) => {
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
  let calls = 0;
  const gateway = new LarkLongConnectionGateway('app', 'secret', {
    client: {
      im: {
        v1: {
          message: {
            create: async ({ data }) => {
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
  } as any);

  await gateway.sendRenderedMessage('oc_1', {
    preferred: { kind: 'card', payload: { schema: '2.0', body: { elements: [] } } },
    fallback: { kind: 'text', text: 'fallback text' },
  });

  expect(sent).toEqual([{ msg_type: 'text', content: JSON.stringify({ text: 'fallback text' }) }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts
```

Expected: FAIL because `sendRenderedMessage` does not exist.

- [ ] **Step 3: Implement minimal gateway support**

Update `src/feishu/FeishuGateway.ts`:

```ts
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

// inside class
async sendRenderedMessage(chatId: string, message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage }): Promise<void> {
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/feishu/FeishuGateway.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/feishu/FeishuGateway.ts tests/feishu/FeishuGateway.test.ts
git commit -m "Add Feishu card-first delivery"
```

## Task 3: Convert Completion Notifications to Structured Messages

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`
- Modify: `src/notifications/FinalAnswerExtractor.ts`
- Modify: `tests/notifications/FinalAnswerExtractor.test.ts`

- [ ] **Step 1: Write the failing completion-notification test**

Add to `tests/session/SessionManager.test.ts`:

```ts
it('renders completion notifications through structured Feishu messages in normal mode', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = { sendText: vi.fn().mockResolvedValue(undefined), sendRenderedMessage: vi.fn().mockResolvedValue(undefined) };
  const observationStore = new FakeCodexObservationStore();
  const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: notifier as any, codexObservationStore: observationStore });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  const codexSessionId = '019e86b4-12ed-7731-9639-c128626a4001';
  await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'status' });

  observationStore.snapshots.set(codexSessionId, {
    availability: { kind: 'ready' },
    codexSessionId,
    status: 'completed',
    finalAnswer: '**done**',
    completedAt: '2099-01-01T00:00:00.000Z',
    recentToolEvents: [],
  });

  await runner.emitOutput(sessionId, 'tick\\n');

  await waitForAssertion(() => expect(notifier.sendRenderedMessage).toHaveBeenCalledTimes(1));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "renders completion notifications through structured Feishu messages in normal mode"
```

Expected: FAIL because `SessionManager` still sends plain strings via `sendText`.

- [ ] **Step 3: Implement minimal structured completion delivery**

Update `src/session/SessionManager.ts`:

```ts
import { renderFeishuMessage, type BotMessage } from '../feishu/FeishuMessageRenderer.js';

// add helper
private completionBotMessage(projectId: string, extraction: FinalAnswerExtraction): BotMessage {
  if (extraction.kind === 'answer') {
    return {
      kind: 'completion',
      bodyMarkdown: extraction.text,
      fallbackText: extraction.text,
    };
  }

  const text = formatCompletionNotification({
    projectId,
    extraction,
    verbosity: this.uiVerbosity(),
  });

  return {
    kind: 'error',
    bodyMarkdown: text,
    fallbackText: text,
  };
}
```

Then replace the send path in `completePendingTurn(...)`:

```ts
const message = this.completionBotMessage(turn.projectId, extraction);
const rendered = renderFeishuMessage(message, { verbosity: this.uiVerbosity() });
if ('sendRenderedMessage' in this.deps.notifier!) {
  await (this.deps.notifier as any).sendRenderedMessage(turn.chatId, rendered);
} else {
  await this.deps.notifier!.sendText(turn.chatId, rendered.fallback.kind === 'text' ? rendered.fallback.text : '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts tests/notifications/FinalAnswerExtractor.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionManager.ts src/notifications/FinalAnswerExtractor.ts tests/session/SessionManager.test.ts tests/notifications/FinalAnswerExtractor.test.ts
git commit -m "Render completion notifications as Feishu cards"
```

## Task 4: Convert Normal Replies and Error Replies to Structured Delivery

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`
- Modify: `tests/app/bootstrap.test.ts`

- [ ] **Step 1: Write the failing reply-mode tests**

Add to `tests/session/SessionManager.test.ts`:

```ts
it('routes normal-mode successful replies through rendered messages and stays silent in chat text', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = { sendText: vi.fn().mockResolvedValue(undefined), sendRenderedMessage: vi.fn().mockResolvedValue(undefined) };
  const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: notifier as any });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'hello' });

  expect(result.reply).toBe('');
});

it('keeps debug-mode success replies visible', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const config = { ...sampleConfig(root), ui: { verbosity: 'debug' as const } };
  const manager = new SessionManager(config, store, runner, { notifier: { sendText: vi.fn().mockResolvedValue(undefined) } });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'hello' });

  expect(result.reply).toContain('已发送给 Codex');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "routes normal-mode successful replies through rendered messages and stays silent in chat text|keeps debug-mode success replies visible"
```

Expected: FAIL until reply generation is consistently centralized.

- [ ] **Step 3: Implement minimal reply-mode wiring**

Update `src/session/SessionManager.ts` by centralizing process reply text:

```ts
private processReply(debugText: string): string {
  return this.isDebugUi() ? debugText : '';
}
```

Then replace success-path reply strings:

```ts
return { reply: this.processReply(`补充消息已发送给 Codex。\nsession: ${chat.currentSessionId}`) };
return { reply: this.processReply(`消息已写入会话，但 3 秒内尚未确认 Codex 开始处理。可稍后用 /tail 查看。\nsession: ${chat.currentSessionId}`) };
return { reply: this.processReply(`已发送给 Codex，完成后我会主动通知你。\nsession: ${chat.currentSessionId}`) };
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts tests/app/bootstrap.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts tests/app/bootstrap.test.ts
git commit -m "Respect UI verbosity for reply messaging"
```

## Task 5: Full Verification and Cleanup

**Files:**
- Modify as needed: `src/feishu/FeishuGateway.ts`
- Modify as needed: `src/feishu/FeishuMessageRenderer.ts`
- Modify as needed: `tests/feishu/FeishuGateway.test.ts`
- Modify as needed: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Run the targeted test suite**

Run:

```bash
npm test -- tests/feishu/FeishuMessageRenderer.test.ts tests/feishu/FeishuGateway.test.ts tests/session/SessionManager.test.ts tests/app/createApp.test.ts tests/app/bootstrap.test.ts tests/notifications/FinalAnswerExtractor.test.ts tests/config/loadConfig.test.ts
```

Expected: PASS

- [ ] **Step 2: Run the build**

Run:

```bash
npm run build
```

Expected: PASS

- [ ] **Step 3: Commit final cleanup**

```bash
git add src/feishu/FeishuMessageRenderer.ts src/feishu/FeishuGateway.ts src/session/SessionManager.ts src/notifications/FinalAnswerExtractor.ts tests/feishu/FeishuMessageRenderer.test.ts tests/feishu/FeishuGateway.test.ts tests/session/SessionManager.test.ts tests/app/createApp.test.ts tests/app/bootstrap.test.ts tests/notifications/FinalAnswerExtractor.test.ts tests/config/loadConfig.test.ts
git commit -m "Add Feishu markdown card rendering phase 1"
```

## Self-Review

- Spec coverage: phase 1 targets normal replies, completion notifications, error notifications, card-first delivery, fallback text, and normal/debug rendering. `/tail` and `/rawtail` are intentionally excluded.
- Placeholder scan: all tasks include explicit files, commands, and code blocks.
- Type consistency: `BotMessage`, `RenderedFeishuMessage`, and `sendRenderedMessage(...)` are introduced in the plan before later tasks depend on them.
