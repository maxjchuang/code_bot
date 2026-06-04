# Feishu Card Selectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Feishu interactive card selectors for `/model` and `/projects`, with card confirms reusing existing text-command behavior.

**Architecture:** Add a bot-owned card action input type at the Feishu gateway boundary, dispatch it through `SessionManager.handleCardAction`, and keep business logic shared with `/model <model> [reasoning]` and `/use <project>`. Add focused card builder modules for model and project selectors; keep the generic markdown renderer unchanged.

**Tech Stack:** TypeScript, Vitest, Feishu/Lark long-connection SDK, existing `RenderedFeishuMessage` card payloads.

---

## File Structure

- Create `src/feishu/FeishuCardActions.ts`: shared card action input and payload parsing types.
- Modify `src/feishu/FeishuGateway.ts`: register card action events and route them to an `onCardAction` callback.
- Test `tests/feishu/FeishuGateway.test.ts`: verify gateway card action routing and malformed action handling.
- Create `src/feishu/ModelSelectorCard.ts`: build the `/model` selector card and text fallback.
- Create `src/feishu/ProjectSelectorCard.ts`: build the `/projects` selector card and text fallback.
- Modify `src/session/SessionManager.ts`: add `handleCardAction`, shared `selectModel`, shared `selectProject`, and card-rendered no-arg `/model` and `/projects`.
- Modify `src/app/createApp.ts`: expose card action wiring through the app object if needed by `src/index.ts`.
- Modify `src/index.ts`: pass gateway card actions into `SessionManager.handleCardAction`.
- Test `tests/session/SessionManager.test.ts`: cover selector card rendering and action behavior.
- Test `tests/app/bootstrap.test.ts` or `tests/app/createApp.test.ts`: cover application wiring when gateway emits card actions.
- Modify `README.md`: document `/model` and `/projects` card selector behavior.

---

### Task 1: Feishu Card Action Gateway

**Files:**
- Create: `src/feishu/FeishuCardActions.ts`
- Modify: `src/feishu/FeishuGateway.ts`
- Test: `tests/feishu/FeishuGateway.test.ts`

- [ ] **Step 1: Write failing gateway tests for card action routing**

Add this type and harness support near the top of `tests/feishu/FeishuGateway.test.ts`:

```ts
type CardActionHandler = (data: {
  event?: {
    context?: { open_message_id?: string };
    operator?: { open_id?: string };
    action?: { value?: unknown };
    token?: string;
  };
}) => Promise<void>;
```

Change `createGatewayHarness` so it captures both text and card handlers:

```ts
let handler: ReceiveHandler | undefined;
let cardHandler: CardActionHandler | undefined;
```

Replace the `register` implementation in `createGatewayHarness` with:

```ts
register: (handlers) => {
  handler = handlers['im.message.receive_v1'];
  cardHandler = handlers['card.action.trigger'];
  return handlers;
},
```

Add this accessor to the returned harness:

```ts
getCardHandler: () => {
  if (!cardHandler) {
    throw new Error('card handler not registered');
  }
  return cardHandler;
},
```

Add a failing test:

```ts
it('routes model selector card actions to onCardAction', async () => {
  const harness = createGatewayHarness();
  const onMessage = vi.fn(async () => ({ text: '' }));
  const onCardAction = vi.fn(async () => ({ text: 'model updated' }));
  await harness.gateway.start(onMessage, onCardAction);

  await harness.getCardHandler()({
    event: {
      context: { open_message_id: 'om_card_1' },
      operator: { open_id: 'ou_1' },
  action: {
    value: {
      kind: 'model_select',
      chatId: 'oc_1',
      chatType: 'group',
    },
    form_value: {
      model: 'gpt-5.5',
      reasoning: 'high',
    },
  },
    },
  });

  expect(onMessage).not.toHaveBeenCalled();
  expect(onCardAction).toHaveBeenCalledWith({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    messageId: 'om_card_1',
    action: {
      kind: 'model_select',
      model: 'gpt-5.5',
      reasoning: 'high',
    },
  });
  expect(harness.sent).toEqual([
    {
      receive_id: 'oc_1',
      content: JSON.stringify({ text: 'model updated' }),
    },
  ]);
});
```

Add a failing malformed-action test:

```ts
it('ignores malformed card actions without throwing', async () => {
  const harness = createGatewayHarness();
  const onMessage = vi.fn(async () => ({ text: '' }));
  const onCardAction = vi.fn(async () => ({ text: 'unused' }));
  await harness.gateway.start(onMessage, onCardAction);

  await harness.getCardHandler()({
    event: {
      context: { open_message_id: 'om_card_1' },
      operator: { open_id: 'ou_1' },
  action: { value: { kind: 'model_select', chatId: 'oc_1' }, form_value: {} },
    },
  });

  expect(onCardAction).not.toHaveBeenCalled();
  expect(harness.sent).toEqual([]);
});
```

- [ ] **Step 2: Run gateway tests and verify failure**

Run:

```bash
npx vitest run tests/feishu/FeishuGateway.test.ts -t "card actions"
```

Expected: FAIL because `start` does not accept `onCardAction`, the dispatcher type does not know `card.action.trigger`, and no card handler is registered.

- [ ] **Step 3: Add card action types and parser**

Create `src/feishu/FeishuCardActions.ts`:

```ts
import type { ChatType } from '../domain/types.js';

export type ModelSelectCardAction = {
  kind: 'model_select';
  model: string;
  reasoning?: string;
};

export type ProjectSelectCardAction = {
  kind: 'project_select';
  projectId: string;
};

export type FeishuCardActionPayload = ModelSelectCardAction | ProjectSelectCardAction;

export interface FeishuIncomingCardAction {
  chatId: string;
  chatType: ChatType;
  userId: string;
  messageId?: string;
  action: FeishuCardActionPayload;
}

export function parseCardActionValue(
  value: unknown,
  formValue?: unknown,
): { chatId: string; chatType: ChatType; action: FeishuCardActionPayload } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const form = isRecord(formValue) ? formValue : {};
  const chatId = typeof value.chatId === 'string' ? value.chatId : undefined;
  if (!chatId) {
    return undefined;
  }
  const chatType = value.chatType === 'group' ? 'group' : 'private';

  if (value.kind === 'model_select') {
    const model = typeof form.model === 'string' ? form.model : typeof value.model === 'string' ? value.model : undefined;
    if (!model) {
      return undefined;
    }
    const reasoning =
      typeof form.reasoning === 'string' && form.reasoning.length > 0
        ? form.reasoning
        : typeof value.reasoning === 'string' && value.reasoning.length > 0
          ? value.reasoning
          : undefined;
    return { chatId, chatType, action: { kind: 'model_select', model, reasoning } };
  }

  if (value.kind === 'project_select') {
    const projectId = typeof form.projectId === 'string' ? form.projectId : typeof value.projectId === 'string' ? value.projectId : undefined;
    if (!projectId) {
      return undefined;
    }
    return { chatId, chatType, action: { kind: 'project_select', projectId } };
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
```

- [ ] **Step 4: Extend `FeishuGateway.start` for card actions**

Modify imports in `src/feishu/FeishuGateway.ts`:

```ts
import { parseCardActionValue, type FeishuIncomingCardAction } from './FeishuCardActions.js';
```

Change the `FeishuGateway` interface:

```ts
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
```

Add card event shape near `LarkReceiveMessageEvent`:

```ts
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
```

Change `EventDispatcherLike`:

```ts
interface EventDispatcherLike {
  register: (handlers: {
    'im.message.receive_v1': (data: LarkReceiveMessageEvent) => Promise<void>;
    'card.action.trigger'?: (data: LarkCardActionEvent) => Promise<void>;
  }) => unknown;
}
```

Change `start` signature:

```ts
async start(
  onMessage: (message: FeishuIncomingMessage) => Promise<FeishuOutgoingReply>,
  onCardAction?: (action: FeishuIncomingCardAction) => Promise<FeishuOutgoingReply>,
): Promise<void> {
```

Add this handler in `dispatcher.register({ ... })` beside the text handler:

```ts
'card.action.trigger': async (data: LarkCardActionEvent) => {
  if (!onCardAction) {
    return;
  }
  const userId = data.event?.operator?.open_id;
  const parsed = parseCardActionValue(data.event?.action?.value, data.event?.action?.form_value);
  if (!userId || !parsed) {
    return;
  }

  const incomingAction: FeishuIncomingCardAction = {
    chatId: parsed.chatId,
    chatType: parsed.chatType,
    userId,
    messageId: data.event?.context?.open_message_id,
    action: parsed.action,
  };

  let reply: FeishuOutgoingReply;
  try {
    reply = await onCardAction(incomingAction);
  } catch (error) {
    await this.recordProcessingFailure('handle_message', {
      chatId: incomingAction.chatId,
      chatType: incomingAction.chatType,
      userId: incomingAction.userId,
      messageId: incomingAction.messageId,
      text: `[card_action:${incomingAction.action.kind}]`,
    }, undefined, error);
    this.logger.error('feishu.handle_card_action_failed', {
      chat: incomingAction.chatId,
      user: incomingAction.userId,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    if (reply.rendered) {
      await this.sendRenderedMessage(incomingAction.chatId, reply.rendered);
    } else if (reply.text !== '') {
      await this.sendText(incomingAction.chatId, reply.text);
    }
  } catch (error) {
    await this.recordProcessingFailure('send_reply', {
      chatId: incomingAction.chatId,
      chatType: incomingAction.chatType,
      userId: incomingAction.userId,
      messageId: incomingAction.messageId,
      text: `[card_action:${incomingAction.action.kind}]`,
    }, reply.text, error);
    this.logger.error('feishu.send_card_action_reply_failed', {
      chat: incomingAction.chatId,
      user: incomingAction.userId,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
},
```

- [ ] **Step 5: Run gateway tests and commit**

Run:

```bash
npx vitest run tests/feishu/FeishuGateway.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/feishu/FeishuCardActions.ts src/feishu/FeishuGateway.ts tests/feishu/FeishuGateway.test.ts
git commit -m "feat: route feishu card actions"
```

---

### Task 2: Model Selector Card Rendering

**Files:**
- Create: `src/feishu/ModelSelectorCard.ts`
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing tests for `/model` selector card**

Add this test near existing `/model` tests in `tests/session/SessionManager.test.ts`:

```ts
it('returns an interactive model selector card for /model with fallback text', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  });
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model' });

  expect(result.reply).toContain('Codex models');
  expect(result.reply).toContain('- gpt-5.5');
  expect(result.renderedReply?.preferred.kind).toBe('card');
  if (result.renderedReply?.preferred.kind !== 'card') {
    throw new Error('expected model selector card');
  }
  const payload = JSON.stringify(result.renderedReply.preferred.payload);
  expect(payload).toContain('Codex Model');
  expect(payload).toContain('select_static');
  expect(payload).toContain('gpt-5.5');
  expect(payload).toContain('confirm_model_select');
  expect(payload).toContain('"kind":"model_select"');
  expect(payload).toContain('"chatId":"oc_1"');
});
```

- [ ] **Step 2: Run test and verify failure**

Run:

```bash
npx vitest run tests/session/SessionManager.test.ts -t "interactive model selector"
```

Expected: FAIL because `/model` has no `renderedReply` card.

- [ ] **Step 3: Create model selector card builder**

Create `src/feishu/ModelSelectorCard.ts`:

```ts
import type { ChatType } from '../domain/types.js';
import type { CodexModelInfo } from '../models/CodexModelCatalog.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export interface ModelSelectorCardInput {
  chatId: string;
  chatType: ChatType;
  projectId?: string;
  currentModel?: string;
  currentReasoning?: string;
  savedModel?: string;
  savedReasoning?: string;
  clientVersion?: string;
  fetchedAt?: string;
  models: CodexModelInfo[];
  fallbackText: string;
}

export function renderModelSelectorCard(input: ModelSelectorCardInput): {
  preferred: RenderedFeishuMessage;
  fallback: RenderedFeishuMessage;
} {
  const defaultModel = input.savedModel ?? input.currentModel ?? input.models[0]?.slug;
  const selected = input.models.find((model) => model.slug === defaultModel) ?? input.models[0];
  const defaultReasoning = input.savedReasoning ?? input.currentReasoning ?? selected?.defaultReasoningLevel ?? selected?.supportedReasoningLevels[0];

  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0',
        header: {
          title: { tag: 'plain_text', content: 'Codex Model' },
          template: 'blue',
        },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: modelSummaryMarkdown(input),
            },
            {
              tag: 'form',
              name: 'model_select_form',
              elements: [
                {
                  tag: 'select_static',
                  name: 'model',
                  placeholder: { tag: 'plain_text', content: 'Select model' },
                  initial_option: defaultModel,
                  options: input.models.map((model) => option(model.slug, model.displayName)),
                },
                {
                  tag: 'select_static',
                  name: 'reasoning',
                  placeholder: { tag: 'plain_text', content: 'Select reasoning' },
                  initial_option: defaultReasoning,
                  options: reasoningOptions(input.models),
                },
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '确认切换' },
                  type: 'primary',
                  action_type: 'form_submit',
                  value: {
                    kind: 'model_select',
                    chatId: input.chatId,
                    chatType: input.chatType,
                  },
                  name: 'confirm_model_select',
                },
              ],
            },
          ],
        },
      },
    },
    fallback: { kind: 'text', text: input.fallbackText },
  };
}

function option(value: string, label: string): Record<string, unknown> {
  return {
    text: { tag: 'plain_text', content: label },
    value,
  };
}

function reasoningOptions(models: CodexModelInfo[]): Array<Record<string, unknown>> {
  const levels = new Set<string>();
  for (const model of models) {
    for (const level of model.supportedReasoningLevels) {
      levels.add(level);
    }
  }
  return [...levels].map((level) => option(level, level));
}

function modelSummaryMarkdown(input: ModelSelectorCardInput): string {
  const lines = ['**Choose a Codex model**'];
  if (input.projectId) {
    lines.push(`Project: \`${input.projectId}\``);
  } else {
    lines.push('Project: not selected');
  }
  if (input.currentModel) {
    lines.push(`Current: \`${input.currentReasoning ? `${input.currentModel} ${input.currentReasoning}` : input.currentModel}\``);
  }
  if (input.savedModel) {
    lines.push(`Saved default: \`${input.savedReasoning ? `${input.savedModel} ${input.savedReasoning}` : input.savedModel}\``);
  }
  if (input.clientVersion) {
    lines.push(`Client: \`${input.clientVersion}\``);
  }
  if (input.fetchedAt) {
    lines.push(`Fetched: \`${input.fetchedAt}\``);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Return model selector card from `/model`**

Modify imports in `src/session/SessionManager.ts`:

```ts
import { renderModelSelectorCard } from '../feishu/ModelSelectorCard.js';
```

Change the no-args `/model` branch:

```ts
if (args.length === 0) {
  return this.modelCatalogReply(chatId, catalog);
}
```

Replace `formatModelCatalog` with a method returning `BotTextResult`:

```ts
private async modelCatalogReply(chatId: string, catalog: Extract<CodexModelCatalog, { kind: 'available' }>): Promise<BotTextResult> {
  const chat = await this.store.getChat(chatId);
  const session = chat?.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
  const currentModel = await this.currentCodexModel(session);
  const savedDefault = chat?.currentProjectId ? chat.modelSelectionsByProject?.[chat.currentProjectId] : undefined;
  const fallbackText = this.formatModelCatalogText(chat, catalog, currentModel);

  return {
    reply: fallbackText,
    renderedReply: renderModelSelectorCard({
      chatId,
      chatType: chat?.chatType ?? 'private',
      projectId: chat?.currentProjectId,
      currentModel: currentModel?.model,
      currentReasoning: currentModel?.reasoningEffort,
      savedModel: savedDefault?.model,
      savedReasoning: savedDefault?.reasoningEffort,
      clientVersion: catalog.clientVersion,
      fetchedAt: catalog.fetchedAt,
      models: catalog.models,
      fallbackText,
    }),
  };
}
```

Rename existing `formatModelCatalog` to:

```ts
private async formatModelCatalogText(
  chat: ChatContext | undefined,
  catalog: Extract<CodexModelCatalog, { kind: 'available' }>,
  currentModel: { model?: string; reasoningEffort?: string } | undefined,
): Promise<string> {
```

Keep the existing body, but remove the duplicated `getChat`, `getSession`, `currentCodexModel` reads from inside the formatter.

- [ ] **Step 5: Run model selector test and commit**

Run:

```bash
npx vitest run tests/session/SessionManager.test.ts -t "interactive model selector"
```

Expected: PASS.

Commit:

```bash
git add src/feishu/ModelSelectorCard.ts src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: render model selector card"
```

---

### Task 3: Model Select Card Action

**Files:**
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing tests for model card action**

Add tests near existing `/model` tests:

```ts
it('handles model_select card action by saving and switching the running session', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  });
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

  const result = await manager.handleCardAction({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    action: { kind: 'model_select', model: 'gpt-5.5', reasoning: 'high' },
  });

  expect(result.reply).toContain('Saved default model: gpt-5.5 high');
  expect(result.reply).toContain('Sent runtime switch to current Codex session. Use /status to confirm the observed model.');
  expect(runner.sentMessages).toEqual(['/model gpt-5.5 high']);
  await expect(store.getChat('oc_1')).resolves.toMatchObject({
    modelSelectionsByProject: {
      repo: {
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        updatedAt: expect.any(String),
      },
    },
  });
});
```

Add no-running-session behavior:

```ts
it('handles model_select card action by saving only when no session is running', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  });
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

  const result = await manager.handleCardAction({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    action: { kind: 'model_select', model: 'gpt-5.5-mini' },
  });

  expect(result.reply).toContain('Saved default model: gpt-5.5-mini');
  expect(result.reply).toContain('No running Codex session. The next /new or /resume will use this model.');
  expect(runner.sentMessages).toEqual([]);
});
```

Add invalid reasoning behavior:

```ts
it('rejects unsupported reasoning in model_select card action', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  });
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

  const result = await manager.handleCardAction({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    action: { kind: 'model_select', model: 'gpt-5.5-mini', reasoning: 'high' },
  });

  expect(result.reply).toBe('Unsupported reasoning level: high\nSupported reasoning levels: low, medium');
  expect(await store.getChat('oc_1')).toMatchObject({ currentProjectId: 'repo' });
  expect(runner.sentMessages).toEqual([]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npx vitest run tests/session/SessionManager.test.ts -t "model_select"
```

Expected: FAIL because `handleCardAction` does not exist.

- [ ] **Step 3: Add `handleCardAction` and shared model selection**

Modify imports in `src/session/SessionManager.ts`:

```ts
import type { FeishuIncomingCardAction, ModelSelectCardAction } from '../feishu/FeishuCardActions.js';
```

Add public method near `handleText`:

```ts
async handleCardAction(input: FeishuIncomingCardAction): Promise<BotTextResult> {
  return this.withChatQueue(input.chatId, () => this.handleCardActionQueued(input));
}

private async handleCardActionQueued(input: FeishuIncomingCardAction): Promise<BotTextResult> {
  if (!isAuthorizedMessage(this.config, { chatId: input.chatId, chatType: input.chatType, userId: input.userId })) {
    return { reply: 'Not authorized.' };
  }

  switch (input.action.kind) {
    case 'model_select':
      return this.selectModel(input.chatId, input.action);
    case 'project_select':
      return { reply: 'Unsupported card action: project_select' };
  }
}
```

Refactor the existing argument branch in `model(...)`:

```ts
const requestedSlug = args[0];
const requestedReasoning = args[1];
return this.selectModel(chatId, {
  kind: 'model_select',
  model: requestedSlug,
  reasoning: requestedReasoning,
});
```

Add shared method by moving existing save/switch logic from `model(...)`:

```ts
private async selectModel(chatId: string, action: ModelSelectCardAction): Promise<BotTextResult> {
  const catalog = await this.modelCatalog().read();
  if (catalog.kind === 'unavailable') {
    return { reply: catalog.message };
  }

  const selected = catalog.models.find((model) => model.slug === action.model);
  if (!selected) {
    return { reply: `Unknown model: ${action.model}\nAvailable models: ${formatModelSlugs(catalog.models)}` };
  }

  if (action.reasoning && !selected.supportedReasoningLevels.includes(action.reasoning)) {
    return {
      reply: `Unsupported reasoning level: ${action.reasoning}\nSupported reasoning levels: ${formatReasoningLevels(selected)}`,
    };
  }

  const chat = await this.store.getChat(chatId);
  if (!chat?.currentProjectId) {
    return { reply: 'No project selected. Run /use <project> or /new <project> first.' };
  }

  const savedModelText = action.reasoning ? `${selected.slug} ${action.reasoning}` : selected.slug;
  await this.store.saveChat({
    ...chat,
    modelSelectionsByProject: {
      ...chat.modelSelectionsByProject,
      [chat.currentProjectId]: {
        model: selected.slug,
        reasoningEffort: action.reasoning,
        updatedAt: new Date().toISOString(),
      },
    },
  });

  const runningSession = chat.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
  const lines = [`Saved default model: ${savedModelText}`];
  if (!runningSession || !isActiveSession(runningSession)) {
    lines.push('No running Codex session. The next /new or /resume will use this model.');
    return { reply: lines.join('\n') };
  }

  const nativeCommand = action.reasoning ? `/model ${selected.slug} ${action.reasoning}` : `/model ${selected.slug}`;
  try {
    await this.runner.send(runningSession.id, nativeCommand);
    lines.push('Sent runtime switch to current Codex session. Use /status to confirm the observed model.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`Runtime switch failed: ${message}`);
  }
  return { reply: lines.join('\n') };
}
```

- [ ] **Step 4: Run model command/action regression tests and commit**

Run:

```bash
npx vitest run tests/session/SessionManager.test.ts -t "model"
```

Expected: PASS for existing text `/model` tests and new card action tests.

Commit:

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: handle model selector actions"
```

---

### Task 4: Project Selector Card and Action

**Files:**
- Create: `src/feishu/ProjectSelectorCard.ts`
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing `/projects` card test**

Add near existing project/use tests:

```ts
it('returns an interactive project selector card for /projects', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/projects' });

  expect(result.reply).toContain('repo: Repo');
  expect(result.renderedReply?.preferred.kind).toBe('card');
  if (result.renderedReply?.preferred.kind !== 'card') {
    throw new Error('expected project selector card');
  }
  const payload = JSON.stringify(result.renderedReply.preferred.payload);
  expect(payload).toContain('Projects');
  expect(payload).toContain('select_static');
  expect(payload).toContain('repo2');
  expect(payload).toContain('confirm_project_select');
  expect(payload).toContain('"kind":"project_select"');
  expect(payload).toContain('"chatId":"oc_1"');
});
```

- [ ] **Step 2: Write failing `project_select` action tests**

Add:

```ts
it('handles project_select card action like /use', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  const result = await manager.handleCardAction({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    action: { kind: 'project_select', projectId: 'repo2' },
  });

  expect(result.reply).toBe('Current project set to repo2.');
  await expect(store.getChat('oc_1')).resolves.toMatchObject({
    chatId: 'oc_1',
    chatType: 'group',
    currentProjectId: 'repo2',
  });
});
```

Add running-session preservation test:

```ts
it('project_select card action does not stop or replace a running session', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

  const result = await manager.handleCardAction({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    action: { kind: 'project_select', projectId: 'repo2' },
  });

  expect(result.reply).toContain('Current project set to repo2.');
  expect(result.reply).toContain(`Running session remains ${sessionId}`);
  expect(await store.getSession(sessionId)).toMatchObject({ status: 'running', projectId: 'repo' });
  await expect(store.getChat('oc_1')).resolves.toMatchObject({
    currentProjectId: 'repo2',
    currentSessionId: sessionId,
  });
});
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npx vitest run tests/session/SessionManager.test.ts -t "project selector|project_select"
```

Expected: FAIL because `/projects` returns text only and `project_select` is unsupported.

- [ ] **Step 4: Create project selector card builder**

Create `src/feishu/ProjectSelectorCard.ts`:

```ts
import type { ChatType, ProjectConfig } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export interface ProjectSelectorCardInput {
  chatId: string;
  chatType: ChatType;
  currentProjectId?: string;
  runningProjectId?: string;
  projects: ProjectConfig[];
  fallbackText: string;
}

export function renderProjectSelectorCard(input: ProjectSelectorCardInput): {
  preferred: RenderedFeishuMessage;
  fallback: RenderedFeishuMessage;
} {
  const defaultProjectId = input.currentProjectId ?? input.projects[0]?.id;
  return {
    preferred: {
      kind: 'card',
      payload: {
        schema: '2.0',
        header: {
          title: { tag: 'plain_text', content: 'Projects' },
          template: 'turquoise',
        },
        body: {
          elements: [
            {
              tag: 'markdown',
              content: projectSummaryMarkdown(input),
            },
            {
              tag: 'form',
              name: 'project_select_form',
              elements: [
                {
                  tag: 'select_static',
                  name: 'projectId',
                  placeholder: { tag: 'plain_text', content: 'Select project' },
                  initial_option: defaultProjectId,
                  options: input.projects.map((project) => option(project.id, `${project.id} - ${project.name}`)),
                },
                {
                  tag: 'button',
                  text: { tag: 'plain_text', content: '确认选择' },
                  type: 'primary',
                  action_type: 'form_submit',
                  value: {
                    kind: 'project_select',
                    chatId: input.chatId,
                    chatType: input.chatType,
                  },
                  name: 'confirm_project_select',
                },
              ],
            },
          ],
        },
      },
    },
    fallback: { kind: 'text', text: input.fallbackText },
  };
}

function option(value: string, label: string): Record<string, unknown> {
  return {
    text: { tag: 'plain_text', content: label },
    value,
  };
}

function projectSummaryMarkdown(input: ProjectSelectorCardInput): string {
  const lines = ['**Choose a project**'];
  if (input.currentProjectId) {
    lines.push(`Current project: \`${input.currentProjectId}\``);
  }
  if (input.runningProjectId) {
    lines.push(`Running session project: \`${input.runningProjectId}\``);
  }
  return lines.join('\n');
}
```

- [ ] **Step 5: Refactor `/use` into shared `selectProject` and return project card**

Modify imports in `src/session/SessionManager.ts`:

```ts
import { renderProjectSelectorCard } from '../feishu/ProjectSelectorCard.js';
import type { FeishuIncomingCardAction, ModelSelectCardAction, ProjectSelectCardAction } from '../feishu/FeishuCardActions.js';
```

In `handleCardActionQueued`, replace the project case:

```ts
case 'project_select':
  return this.selectProject(input.chatId, input.chatType, input.action);
```

Change existing `/use` handling to call shared logic:

```ts
private async useProject(chatId: string, chatType: ChatType, args: string[]): Promise<BotTextResult> {
  if (args.length !== 1) {
    return { reply: 'Usage: /use <project>' };
  }
  return this.selectProject(chatId, chatType, { kind: 'project_select', projectId: args[0] });
}
```

Add shared method by moving current `/use` behavior into:

```ts
private async selectProject(chatId: string, chatType: ChatType, action: ProjectSelectCardAction): Promise<BotTextResult> {
  const project = resolveProject(this.config, action.projectId);
  if (!project) {
    return { reply: `Unknown project: ${action.projectId}` };
  }
  const existingChat = await this.store.getChat(chatId);
  const runningSession = existingChat?.currentSessionId ? await this.store.getSession(existingChat.currentSessionId) : undefined;
  await this.store.saveChat({
    chatId,
    chatType,
    currentProjectId: project.id,
    currentSessionId: existingChat?.currentSessionId,
    modelSelectionsByProject: existingChat?.modelSelectionsByProject,
  });
  const lines = [`Current project set to ${project.id}.`];
  if (runningSession && isActiveSession(runningSession) && runningSession.projectId !== project.id) {
    lines.push(`Running session remains ${runningSession.id} (${runningSession.projectId}). Use /new ${project.id} to start a session for the selected project.`);
  }
  return { reply: lines.join('\n') };
}
```

Change `/projects` method to return card:

```ts
private async listProjects(chatId: string): Promise<BotTextResult> {
  const chat = await this.store.getChat(chatId);
  const session = chat?.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
  const fallbackText = this.config.projects.map((project) => `${project.id}: ${project.name} (${project.path})`).join('\n') || 'No projects configured.';
  if (this.config.projects.length === 0) {
    return { reply: fallbackText };
  }
  return {
    reply: fallbackText,
    renderedReply: renderProjectSelectorCard({
      chatId,
      chatType: chat?.chatType ?? 'private',
      currentProjectId: chat?.currentProjectId,
      runningProjectId: session?.projectId,
      projects: this.config.projects,
      fallbackText,
    }),
  };
}
```

If the existing `listProjects` signature has no `chatId`, update the router call to pass `input.chatId`.

- [ ] **Step 6: Run project selector tests and commit**

Run:

```bash
npx vitest run tests/session/SessionManager.test.ts -t "project selector|project_select|preserves saved model selection when /use"
```

Expected: PASS.

Commit:

```bash
git add src/feishu/ProjectSelectorCard.ts src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: add project selector card"
```

---

### Task 5: App Wiring, Documentation, and Verification

**Files:**
- Modify: `src/index.ts`
- Test: `tests/app/bootstrap.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing app wiring test**

In `tests/app/bootstrap.test.ts`, update the import:

```ts
import type { FeishuIncomingMessage } from '../../src/feishu/FeishuGateway.js';
import type { FeishuIncomingCardAction } from '../../src/feishu/FeishuCardActions.js';
```

Add this test after `records inbound message and reply events around gateway dispatch`:

```ts
it('routes Feishu card actions into the session manager', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const logger = { info: vi.fn(), error: vi.fn() };
  const handleCardAction = vi.fn().mockResolvedValue({ reply: 'Current project set to repo2.' });
  let onCardAction: ((action: FeishuIncomingCardAction) => Promise<{ text: string; rendered?: unknown }>) | undefined;

  const gatewayStart = vi.fn(
    async (
      _onMessage: (message: FeishuIncomingMessage) => Promise<{ text: string; rendered?: unknown }>,
      cardActionHandler?: (action: FeishuIncomingCardAction) => Promise<{ text: string; rendered?: unknown }>,
    ) => {
      onCardAction = cardActionHandler;
    },
  );

  await bootstrap({
    projectRoot: root,
    loadConfig: async () => sampleConfig(root),
    createStore: () => store,
    createCodexRunner: () => ({ healthCheck: async () => ({ ok: true }), start: async () => undefined, send: async () => undefined, stop: async () => undefined }),
    createGateway: () => ({
      start: gatewayStart,
      sendText: async () => undefined,
      sendRenderedMessage: async () => undefined,
    }),
    createApp: () =>
      ({
        sessionManager: {
          handleText: async () => ({ reply: '' }),
          handleCardAction,
        },
        healthCheck: async () => ({ ok: true }),
      }) as never,
    logger,
  });

  expect(onCardAction).toBeDefined();
  const dispatch = onCardAction as (action: FeishuIncomingCardAction) => Promise<{ text: string; rendered?: unknown }>;

  await expect(
    dispatch({
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      messageId: 'om_card_1',
      action: { kind: 'project_select', projectId: 'repo2' },
    }),
  ).resolves.toEqual({
    text: 'Current project set to repo2.',
    rendered: undefined,
  });

  expect(handleCardAction).toHaveBeenCalledWith({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    messageId: 'om_card_1',
    action: { kind: 'project_select', projectId: 'repo2' },
  });
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('inbound.card_action_received'));
  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('outbound.card_action_replied'));
});
```

- [ ] **Step 2: Run app wiring test and verify failure**

Run:

```bash
npx vitest run tests/app/bootstrap.test.ts -t "card actions"
```

Expected: FAIL because the app currently passes only the text message callback to `gateway.start`.

- [ ] **Step 3: Wire card actions through `src/index.ts`**

Update imports in `src/index.ts`:

```ts
import type { FeishuIncomingMessage } from './feishu/FeishuGateway.js';
import type { FeishuIncomingCardAction } from './feishu/FeishuCardActions.js';
```

Extract the current inline text callback into a local constant inside `bootstrap` before `gateway.start`. Keep the existing body unchanged:

```ts
const onMessage = async (message: FeishuIncomingMessage) => {
  logger.info('inbound.received', {
    chat: message.chatId,
    type: message.chatType,
    messageId: message.messageId,
    text: message.text,
  });
  const receivedAt = new Date().toISOString();
  await store.appendEvent({
    type: 'command.received',
    at: receivedAt,
    data: {
      chatId: message.chatId,
      chatType: message.chatType,
      userId: message.userId,
      messageId: message.messageId,
      text: message.text,
      wasMentioned: message.wasMentioned,
      mentionsOpenIds: message.mentionsOpenIds,
      botOpenIdResolved: message.botOpenIdResolved,
    },
  });
  let claim: ClaimInboundMessageResult;
  try {
    claim = await store.claimInboundMessage(message);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('inbound.dedupe_failed', {
      chat: message.chatId,
      type: message.chatType,
      messageId: message.messageId,
      reason: errorMessage,
    });
    await store.appendErrorLog({
      at: new Date().toISOString(),
      source: 'inbound.dedupe',
      message: errorMessage,
      data: {
        chatId: message.chatId,
        chatType: message.chatType,
        userId: message.userId,
        messageId: message.messageId,
      },
    });
    return { text: '', rendered: undefined };
  }

  if (!claim.claimed) {
    await store.appendEvent({
      type: 'command.duplicate_dropped',
      at: new Date().toISOString(),
      data: {
        chatId: message.chatId,
        chatType: message.chatType,
        userId: message.userId,
        messageId: message.messageId,
        text: message.text,
        duplicateCount: claim.receipt.duplicateCount,
      },
    });
    return { text: '', rendered: undefined };
  }

  const result = await app.sessionManager.handleText(message);
  logger.info('outbound.replied', {
    chat: message.chatId,
    type: message.chatType,
    messageId: message.messageId,
    reply: result.reply,
  });
  await store.appendEvent({
    type: 'command.replied',
    at: new Date().toISOString(),
    data: {
      chatId: message.chatId,
      chatType: message.chatType,
      userId: message.userId,
      messageId: message.messageId,
      text: message.text,
      replyPreview: result.reply.length <= 200 ? result.reply : `${result.reply.slice(0, 197)}...`,
    },
  });
  return { text: result.reply, rendered: result.renderedReply };
};
```

Add a second local callback:

```ts
const onCardAction = async (action: FeishuIncomingCardAction) => {
  logger.info('inbound.card_action_received', {
    chat: action.chatId,
    type: action.chatType,
    messageId: action.messageId,
    kind: action.action.kind,
  });
  await store.appendEvent({
    type: 'card_action.received',
    at: new Date().toISOString(),
    data: {
      chatId: action.chatId,
      chatType: action.chatType,
      userId: action.userId,
      messageId: action.messageId,
      action: action.action,
    },
  });
  const result = await app.sessionManager.handleCardAction(action);
  logger.info('outbound.card_action_replied', {
    chat: action.chatId,
    type: action.chatType,
    messageId: action.messageId,
    kind: action.action.kind,
    reply: result.reply,
  });
  await store.appendEvent({
    type: 'card_action.replied',
    at: new Date().toISOString(),
    data: {
      chatId: action.chatId,
      chatType: action.chatType,
      userId: action.userId,
      messageId: action.messageId,
      action: action.action,
      replyPreview: result.reply.length <= 200 ? result.reply : `${result.reply.slice(0, 197)}...`,
    },
  });
  return { text: result.reply, rendered: result.renderedReply };
};
```

Replace the existing single-callback start call with:

```ts
await gateway.start(onMessage, onCardAction);
```

- [ ] **Step 4: Update README**

Modify the command list in `README.md` to clarify selector behavior:

```md
/projects
/use <project>
/model [model] [reasoning]
```

Update the descriptions:

```md
- `/projects` shows configured projects. In Feishu it prefers an interactive project selector card; `/use <project>` remains the text fallback/direct command.
- `/model [model] [reasoning]` lists or switches Codex-supported models. In Feishu, `/model` prefers an interactive card with model and reasoning dropdowns; `/model <model> [reasoning]` remains the text fallback/direct command.
```

- [ ] **Step 5: Run full verification**

Run:

```bash
npm test
npm run build
```

Expected:

```text
vitest exits 0 with all test files passed
tsc -p tsconfig.json exits 0
```

- [ ] **Step 6: Commit final wiring/docs**

Commit:

```bash
git add src/index.ts tests/app/bootstrap.test.ts README.md
git commit -m "feat: wire card selector actions"
```

---

## Final Review Checklist

- [ ] `/model` no args returns an interactive selector card and text fallback.
- [ ] `/model <model> [reasoning]` still works.
- [ ] `model_select` card action reuses the same model save/switch logic.
- [ ] `/projects` returns an interactive selector card and text fallback.
- [ ] `/use <project>` still works.
- [ ] `project_select` card action reuses the same project selection logic.
- [ ] Card actions run authorization checks.
- [ ] Card actions are serialized through the per-chat queue.
- [ ] Gateway handles malformed card actions without throwing.
- [ ] `npm test` passes.
- [ ] `npm run build` passes.
