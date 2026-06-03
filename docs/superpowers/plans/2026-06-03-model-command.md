# `/model` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `/model` command that lists Codex-supported models from `~/.codex/models_cache.json`, saves a chat/project default model, switches a running Codex session, and applies the saved model to future `/new` and `/resume`.

**Architecture:** Add a focused model catalog reader for Codex's structured cache, store model selections on `ChatContext` keyed by project, and keep command orchestration in `SessionManager`. Future session startup derives effective Codex args by removing existing model flags and appending the saved model plus `-c model_reasoning_effort="<effort>"` when reasoning is selected.

**Tech Stack:** TypeScript, Vitest, Node `fs/promises`, existing `FileStateStore`, existing `SessionManager` command routing.

---

## File Structure

- Create `src/models/CodexModelCatalog.ts`: reads and validates Codex `models_cache.json`, normalizes visible models, and formats catalog errors.
- Create `tests/models/CodexModelCatalog.test.ts`: focused unit tests for parsing, sorting, validation, and degraded cache states.
- Modify `src/domain/types.ts`: add `SavedModelSelection` and `modelSelectionsByProject` to `ChatContext`.
- Modify `src/commands/CommandRouter.ts`: add `model` to the command union.
- Modify `src/session/SessionManager.ts`: add `/model` handling, saved selection persistence, runtime switch dispatch, and saved-selection startup arg merging.
- Modify `tests/helpers/fakes.ts`: keep using `FakeCodexRunner.sentMessages`; no new fake runner behavior is required unless implementation introduces a catalog dependency.
- Modify `tests/session/SessionManager.test.ts`: add integration coverage for `/model`, runtime switching, missing project, invalid model/reasoning, and future session args.
- Modify `src/session/SessionManager.ts` help text: include `/model [model] [reasoning]`.

---

### Task 1: Add Codex Model Catalog Reader

**Files:**
- Create: `src/models/CodexModelCatalog.ts`
- Test: `tests/models/CodexModelCatalog.test.ts`

- [ ] **Step 1: Write failing catalog parser tests**

Create `tests/models/CodexModelCatalog.test.ts`:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readCodexModelCatalog } from '../../src/models/CodexModelCatalog.js';
import { createTmpDir } from '../helpers/tmp.js';

async function writeCache(root: string, value: unknown): Promise<void> {
  const codexHome = join(root, '.codex');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'models_cache.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

describe('readCodexModelCatalog', () => {
  it('reads visible models sorted by priority and slug', async () => {
    const root = await createTmpDir();
    await writeCache(root, {
      fetched_at: '2026-06-03T13:26:06.832369Z',
      client_version: '0.136.0',
      models: [
        {
          slug: 'hidden-model',
          display_name: 'Hidden',
          visibility: 'hidden',
          priority: 1,
        },
        {
          slug: 'gpt-5.4',
          display_name: 'GPT-5.4',
          description: 'Strong model for everyday coding.',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
          visibility: 'list',
          priority: 20,
        },
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          description: 'Frontier model.',
          default_reasoning_level: 'medium',
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
          visibility: 'list',
          priority: 10,
        },
      ],
    });

    const catalog = await readCodexModelCatalog({ codexHome: join(root, '.codex') });

    expect(catalog).toEqual({
      kind: 'available',
      fetchedAt: '2026-06-03T13:26:06.832369Z',
      clientVersion: '0.136.0',
      models: [
        {
          slug: 'gpt-5.5',
          displayName: 'GPT-5.5',
          description: 'Frontier model.',
          priority: 10,
          defaultReasoningLevel: 'medium',
          supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
        },
        {
          slug: 'gpt-5.4',
          displayName: 'GPT-5.4',
          description: 'Strong model for everyday coding.',
          priority: 20,
          defaultReasoningLevel: 'medium',
          supportedReasoningLevels: ['low', 'medium', 'high'],
        },
      ],
    });
  });

  it('returns a clear missing-cache result', async () => {
    const root = await createTmpDir();

    await expect(readCodexModelCatalog({ codexHome: join(root, '.codex') })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'missing',
      message: 'Codex model cache not found. Open Codex once or run a Codex command that refreshes models, then try /model again.',
    });
  });

  it('returns a clear invalid-cache result', async () => {
    const root = await createTmpDir();
    const codexHome = join(root, '.codex');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'models_cache.json'), '{bad json', 'utf8');

    await expect(readCodexModelCatalog({ codexHome })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'invalid',
      message: 'Codex model cache is unreadable.',
    });
  });

  it('returns a clear empty-cache result when no visible models exist', async () => {
    const root = await createTmpDir();
    await writeCache(root, { fetched_at: '2026-06-03T13:26:06.832369Z', client_version: '0.136.0', models: [] });

    await expect(readCodexModelCatalog({ codexHome: join(root, '.codex') })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'empty',
      message: 'Codex model cache contains no selectable models.',
    });
  });
});
```

- [ ] **Step 2: Run catalog tests and verify failure**

Run:

```bash
pnpm vitest run tests/models/CodexModelCatalog.test.ts
```

Expected: FAIL because `src/models/CodexModelCatalog.ts` does not exist.

- [ ] **Step 3: Implement catalog reader**

Create `src/models/CodexModelCatalog.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CodexModelInfo {
  slug: string;
  displayName: string;
  description?: string;
  priority: number;
  defaultReasoningLevel?: string;
  supportedReasoningLevels: string[];
}

export type CodexModelCatalog =
  | {
      kind: 'available';
      fetchedAt?: string;
      clientVersion?: string;
      models: CodexModelInfo[];
    }
  | {
      kind: 'unavailable';
      reason: 'missing' | 'invalid' | 'empty';
      message: string;
    };

export async function readCodexModelCatalog(input: { codexHome?: string }): Promise<CodexModelCatalog> {
  const codexHome = input.codexHome ?? `${process.env.HOME ?? ''}/.codex`;
  const filePath = join(codexHome, 'models_cache.json');
  let parsed: unknown;

  try {
    parsed = JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        kind: 'unavailable',
        reason: 'missing',
        message: 'Codex model cache not found. Open Codex once or run a Codex command that refreshes models, then try /model again.',
      };
    }
    return {
      kind: 'unavailable',
      reason: 'invalid',
      message: 'Codex model cache is unreadable.',
    };
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.models)) {
    return {
      kind: 'unavailable',
      reason: 'invalid',
      message: 'Codex model cache is unreadable.',
    };
  }

  const models = parsed.models
    .map(normalizeModel)
    .filter((model): model is CodexModelInfo => Boolean(model))
    .sort((a, b) => a.priority - b.priority || a.slug.localeCompare(b.slug));

  if (models.length === 0) {
    return {
      kind: 'unavailable',
      reason: 'empty',
      message: 'Codex model cache contains no selectable models.',
    };
  }

  return {
    kind: 'available',
    fetchedAt: typeof parsed.fetched_at === 'string' ? parsed.fetched_at : undefined,
    clientVersion: typeof parsed.client_version === 'string' ? parsed.client_version : undefined,
    models,
  };
}

function normalizeModel(value: unknown): CodexModelInfo | undefined {
  if (!isRecord(value) || value.visibility !== 'list' || typeof value.slug !== 'string') {
    return undefined;
  }

  return {
    slug: value.slug,
    displayName: typeof value.display_name === 'string' ? value.display_name : value.slug,
    description: typeof value.description === 'string' ? value.description : undefined,
    priority: typeof value.priority === 'number' && Number.isFinite(value.priority) ? value.priority : Number.MAX_SAFE_INTEGER,
    defaultReasoningLevel: typeof value.default_reasoning_level === 'string' ? value.default_reasoning_level : undefined,
    supportedReasoningLevels: Array.isArray(value.supported_reasoning_levels)
      ? value.supported_reasoning_levels
          .map((item) => (isRecord(item) && typeof item.effort === 'string' ? item.effort : undefined))
          .filter((effort): effort is string => Boolean(effort))
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
```

- [ ] **Step 4: Run catalog tests and verify pass**

Run:

```bash
pnpm vitest run tests/models/CodexModelCatalog.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit catalog reader**

```bash
git add src/models/CodexModelCatalog.ts tests/models/CodexModelCatalog.test.ts
git commit -m "feat: read codex model catalog"
```

---

### Task 2: Add Saved Model Selection State

**Files:**
- Modify: `src/domain/types.ts`
- Test: `tests/state/FileStateStore.test.ts`

- [ ] **Step 1: Write failing state persistence test**

Append to `tests/state/FileStateStore.test.ts`:

```ts
it('persists model selections on chat context', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);

  await store.saveChat({
    chatId: 'oc_1',
    chatType: 'group',
    currentProjectId: 'repo',
    modelSelectionsByProject: {
      repo: {
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        updatedAt: '2026-06-03T10:00:00.000Z',
      },
    },
  });

  await expect(store.getChat('oc_1')).resolves.toMatchObject({
    modelSelectionsByProject: {
      repo: {
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        updatedAt: '2026-06-03T10:00:00.000Z',
      },
    },
  });
});
```

- [ ] **Step 2: Run state test and verify failure**

Run:

```bash
pnpm vitest run tests/state/FileStateStore.test.ts -t "model selections"
```

Expected: FAIL with a TypeScript error because `modelSelectionsByProject` is not part of `ChatContext`.

- [ ] **Step 3: Add domain types**

Modify `src/domain/types.ts`:

```ts
export interface SavedModelSelection {
  model: string;
  reasoningEffort?: string;
  updatedAt: string;
}

export interface ChatContext {
  chatId: string;
  chatType: ChatType;
  currentProjectId?: string;
  currentSessionId?: string;
  modelSelectionsByProject?: Record<string, SavedModelSelection>;
}
```

- [ ] **Step 4: Run state test and verify pass**

Run:

```bash
pnpm vitest run tests/state/FileStateStore.test.ts -t "model selections"
```

Expected: PASS.

- [ ] **Step 5: Commit state type**

```bash
git add src/domain/types.ts tests/state/FileStateStore.test.ts
git commit -m "feat: store chat model selections"
```

---

### Task 3: Add `/model` Listing and Validation

**Files:**
- Modify: `src/commands/CommandRouter.ts`
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/helpers/fakes.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Add command parser test**

Append to `tests/commands/CommandRouter.test.ts`:

```ts
it('parses model commands', () => {
  expect(parseIncomingText('/model')).toEqual({ kind: 'command', name: 'model', args: [], raw: '/model' });
  expect(parseIncomingText('/model gpt-5.5 high')).toEqual({
    kind: 'command',
    name: 'model',
    args: ['gpt-5.5', 'high'],
    raw: '/model gpt-5.5 high',
  });
});
```

- [ ] **Step 2: Add SessionManager catalog injection helper for tests**

Modify `tests/helpers/fakes.ts` to export a reusable catalog:

```ts
export const sampleModelCatalog = {
  kind: 'available' as const,
  fetchedAt: '2026-06-03T13:26:06.832369Z',
  clientVersion: '0.136.0',
  models: [
    {
      slug: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Frontier model.',
      priority: 10,
      defaultReasoningLevel: 'medium',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    },
    {
      slug: 'gpt-5.4',
      displayName: 'GPT-5.4',
      description: 'Strong model for everyday coding.',
      priority: 20,
      defaultReasoningLevel: 'medium',
      supportedReasoningLevels: ['low', 'medium', 'high', 'xhigh'],
    },
  ],
};
```

- [ ] **Step 3: Add failing `/model` listing and validation tests**

Import `sampleModelCatalog` in `tests/session/SessionManager.test.ts`:

```ts
import { FakeCodexObservationStore, FakeCodexRunner, sampleConfig, sampleModelCatalog } from '../helpers/fakes.js';
```

Append these tests inside `describe('SessionManager', () => { ... })`:

```ts
it('lists Codex models from the model catalog', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model' });

  expect(result.reply).toContain('Codex models (client 0.136.0, fetched 2026-06-03T13:26:06.832369Z)');
  expect(result.reply).toContain('- gpt-5.5: GPT-5.5 - Frontier model. Reasoning: low, medium, high, xhigh');
  expect(result.reply).toContain('- gpt-5.4: GPT-5.4 - Strong model for everyday coding. Reasoning: low, medium, high, xhigh');
});

it('rejects unknown models and lists available slugs', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model nope' });

  expect(result.reply).toBe('Unknown model: nope\nAvailable models: gpt-5.5, gpt-5.4');
});

it('rejects unsupported reasoning levels', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5 turbo' });

  expect(result.reply).toBe('Unsupported reasoning level for gpt-5.5: turbo\nSupported reasoning levels: low, medium, high, xhigh');
});
```

- [ ] **Step 4: Run command tests and verify failure**

Run:

```bash
pnpm vitest run tests/commands/CommandRouter.test.ts tests/session/SessionManager.test.ts -t "model"
```

Expected: FAIL because `model` is not routed and `SessionManager` does not accept `modelCatalog`.

- [ ] **Step 5: Add model command wiring and catalog dependency**

Modify `src/commands/CommandRouter.ts`:

```ts
export type CommandName =
  | 'help'
  | 'projects'
  | 'use'
  | 'new'
  | 'resume'
  | 'send'
  | 'status'
  | 'model'
  | 'tail'
  | 'rawtail'
  | 'stop'
  | 'sessions'
  | 'approve'
  | 'reject';
```

Modify `src/session/SessionManager.ts` imports:

```ts
import { readCodexModelCatalog, type CodexModelCatalog, type CodexModelInfo } from '../models/CodexModelCatalog.js';
import type { BotConfig, BotEvent, ChatContext, SavedModelSelection, SessionRecord } from '../domain/types.js';
```

Add dependency type near existing dependency declarations:

```ts
type ModelCatalogReader = {
  read(): Promise<CodexModelCatalog>;
};
```

Add a private field:

```ts
private readonly modelCatalog: ModelCatalogReader;
```

Initialize it in the constructor:

```ts
this.modelCatalog =
  deps.modelCatalog ??
  {
    read: () =>
      readCodexModelCatalog({
        codexHome: process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`,
      }),
  };
```

Extend the dependency type accepted by the constructor with:

```ts
modelCatalog?: ModelCatalogReader;
```

Add switch case:

```ts
case 'model':
  return this.model(input, parsed.args);
```

Add these methods to `SessionManager`:

```ts
private async model(input: IncomingBotText, args: string[]): Promise<BotTextResult> {
  if (args.length > 2) {
    return { reply: 'Usage: /model [model] [reasoning]' };
  }

  const catalog = await this.modelCatalog.read();
  if (catalog.kind === 'unavailable') {
    return { reply: catalog.message };
  }

  if (args.length === 0) {
    const chat = await this.store.getChat(input.chatId);
    const currentModel = await this.currentObservedModel(chat);
    const savedSelection = this.savedModelSelection(chat);
    return { reply: this.formatModelList(catalog, currentModel, savedSelection) };
  }

  const selected = catalog.models.find((model) => model.slug === args[0]);
  if (!selected) {
    return { reply: `Unknown model: ${args[0]}\nAvailable models: ${catalog.models.map((model) => model.slug).join(', ')}` };
  }

  const reasoningEffort = args[1];
  if (reasoningEffort && !selected.supportedReasoningLevels.includes(reasoningEffort)) {
    return {
      reply: `Unsupported reasoning level for ${selected.slug}: ${reasoningEffort}\nSupported reasoning levels: ${selected.supportedReasoningLevels.join(', ')}`,
    };
  }

  return this.saveAndSwitchModel(input, selected, reasoningEffort);
}

private formatModelList(catalog: Extract<CodexModelCatalog, { kind: 'available' }>, currentModel?: string, saved?: SavedModelSelection): string {
  const lines: string[] = [];
  if (currentModel) {
    lines.push(`Current model: ${currentModel}`);
  }
  if (saved) {
    lines.push(`Saved default: ${this.formatModelSelection(saved)}`);
  }
  lines.push(`Codex models (client ${catalog.clientVersion ?? 'unknown'}, fetched ${catalog.fetchedAt ?? 'unknown'})`, '');
  for (const model of catalog.models) {
    const description = model.description ? ` - ${model.description}` : '';
    const reasoning = model.supportedReasoningLevels.length > 0 ? ` Reasoning: ${model.supportedReasoningLevels.join(', ')}` : '';
    lines.push(`- ${model.slug}: ${model.displayName}${description}.${reasoning}`.replace('..', '.'));
  }
  return lines.join('\n');
}

private formatModelSelection(selection: SavedModelSelection): string {
  return selection.reasoningEffort ? `${selection.model} ${selection.reasoningEffort}` : selection.model;
}

private savedModelSelection(chat?: ChatContext): SavedModelSelection | undefined {
  if (!chat?.currentProjectId) {
    return undefined;
  }
  return chat.modelSelectionsByProject?.[chat.currentProjectId];
}

private async currentObservedModel(chat?: ChatContext): Promise<string | undefined> {
  if (!chat?.currentSessionId) {
    return undefined;
  }
  const session = await this.store.getSession(chat.currentSessionId);
  if (!session) {
    return undefined;
  }
  const codexStatus = await this.codexStatusResult(session);
  return codexStatus.kind === 'available' ? codexStatus.status.summary.model : undefined;
}
```

Add a placeholder `saveAndSwitchModel` that returns a clear temporary reply so listing tests pass while switch tests are added in the next task:

```ts
private async saveAndSwitchModel(_input: IncomingBotText, selected: CodexModelInfo, reasoningEffort?: string): Promise<BotTextResult> {
  return { reply: `Selected model: ${reasoningEffort ? `${selected.slug} ${reasoningEffort}` : selected.slug}` };
}
```

Update `helpText()` command list:

```ts
'/model [model] [reasoning]\n'
```

- [ ] **Step 6: Run listing and validation tests**

Run:

```bash
pnpm vitest run tests/commands/CommandRouter.test.ts tests/session/SessionManager.test.ts -t "model"
```

Expected: PASS for parser, listing, unknown model, unsupported reasoning. Runtime save/switch behavior is still intentionally not covered until Task 4.

- [ ] **Step 7: Commit command listing**

```bash
git add src/commands/CommandRouter.ts src/session/SessionManager.ts tests/helpers/fakes.ts tests/commands/CommandRouter.test.ts tests/session/SessionManager.test.ts
git commit -m "feat: list codex models"
```

---

### Task 4: Save Model Selection and Switch Running Session

**Files:**
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing save-only and runtime-switch tests**

Append to `tests/session/SessionManager.test.ts`:

```ts
it('saves model selection without a running session', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);
  await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5 high' });

  expect(result.reply).toContain('Saved default model: gpt-5.5 high');
  expect(result.reply).toContain('No running Codex session. The next /new or /resume will use this model.');
  expect(runner.sentMessages).toEqual([]);
  await expect(store.getChat('oc_1')).resolves.toMatchObject({
    modelSelectionsByProject: {
      repo: {
        model: 'gpt-5.5',
        reasoningEffort: 'high',
      },
    },
  });
});

it('saves model selection and sends runtime switch to running session', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5 high' });

  expect(result.reply).toContain('Saved default model: gpt-5.5 high');
  expect(result.reply).toContain('Sent runtime switch to current Codex session. Use /status to confirm the observed model.');
  expect(runner.sentMessages).toEqual(['/model gpt-5.5 high']);
});

it('requires a selected project before saving model selection', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5' });

  expect(result.reply).toBe('No project selected. Run /use <project> or /new <project> first.');
});

it('keeps saved default when runtime switch fails', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const chat = await store.getChat('oc_1');
  runner.dropSession(chat!.currentSessionId!);

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/model gpt-5.5' });

  expect(result.reply).toContain('Saved default model: gpt-5.5');
  expect(result.reply).toContain('Runtime switch failed: Unknown fake session:');
  await expect(store.getChat('oc_1')).resolves.toMatchObject({
    modelSelectionsByProject: {
      repo: {
        model: 'gpt-5.5',
      },
    },
  });
});
```

- [ ] **Step 2: Run save/switch tests and verify failure**

Run:

```bash
pnpm vitest run tests/session/SessionManager.test.ts -t "model selection|runtime switch|selected project"
```

Expected: FAIL because `saveAndSwitchModel` does not persist or call `runner.send`.

- [ ] **Step 3: Implement save and runtime switch**

Replace the placeholder `saveAndSwitchModel` in `src/session/SessionManager.ts`:

```ts
private async saveAndSwitchModel(input: IncomingBotText, selected: CodexModelInfo, reasoningEffort?: string): Promise<BotTextResult> {
  const chat = await this.store.getChat(input.chatId);
  if (!chat?.currentProjectId) {
    return { reply: 'No project selected. Run /use <project> or /new <project> first.' };
  }

  const selection: SavedModelSelection = {
    model: selected.slug,
    reasoningEffort,
    updatedAt: new Date().toISOString(),
  };
  await this.store.saveChat({
    ...chat,
    modelSelectionsByProject: {
      ...(chat.modelSelectionsByProject ?? {}),
      [chat.currentProjectId]: selection,
    },
  });

  const lines = [`Saved default model: ${this.formatModelSelection(selection)}`];
  const session = chat.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
  if (!session || session.status !== 'running') {
    lines.push('No running Codex session. The next /new or /resume will use this model.');
    return { reply: lines.join('\n') };
  }

  const command = reasoningEffort ? `/model ${selected.slug} ${reasoningEffort}` : `/model ${selected.slug}`;
  try {
    await this.runner.send(session.id, command);
    lines.push('Sent runtime switch to current Codex session. Use /status to confirm the observed model.');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`Runtime switch failed: ${message}`);
  }

  return { reply: lines.join('\n') };
}
```

- [ ] **Step 4: Run save/switch tests and verify pass**

Run:

```bash
pnpm vitest run tests/session/SessionManager.test.ts -t "model selection|runtime switch|selected project"
```

Expected: PASS.

- [ ] **Step 5: Commit save and runtime switch**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: switch codex model command"
```

---

### Task 5: Apply Saved Model to `/new` and `/resume`

**Files:**
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing startup arg tests**

Append to `tests/session/SessionManager.test.ts`:

```ts
it('uses saved model selection when starting a new session', async () => {
  const root = await createTmpDir();
  const config: BotConfig = {
    ...sampleConfig(root),
    projects: [{ id: 'repo', name: 'Repo', path: root, codexArgs: ['--model', 'gpt-5.4-mini', '--search'] }],
  };
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(config, store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);
  await store.saveChat({
    chatId: 'oc_1',
    chatType: 'group',
    currentProjectId: 'repo',
    modelSelectionsByProject: {
      repo: {
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        updatedAt: '2026-06-03T10:00:00.000Z',
      },
    },
  });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

  expect(runner.starts[0].args).toEqual(['--search', '--model', 'gpt-5.5', '-c', 'model_reasoning_effort="high"']);
});

it('uses saved model selection when resuming a native Codex session', async () => {
  const root = await createTmpDir();
  const config: BotConfig = {
    ...sampleConfig(root),
    projects: [{ id: 'repo', name: 'Repo', path: root, codexArgs: ['-m', 'gpt-5.4'] }],
  };
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(config, store, runner, {
    modelCatalog: { read: async () => sampleModelCatalog },
  } as any);
  await store.saveChat({
    chatId: 'oc_1',
    chatType: 'group',
    currentProjectId: 'repo',
    modelSelectionsByProject: {
      repo: {
        model: 'gpt-5.5',
        updatedAt: '2026-06-03T10:00:00.000Z',
      },
    },
  });

  await manager.handleText({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    text: '/resume 019e7f20-a667-7632-a808-c9595d77116e repo',
  });

  expect(runner.starts[0].args).toEqual(['--model', 'gpt-5.5']);
});
```

- [ ] **Step 2: Run startup arg tests and verify failure**

Run:

```bash
pnpm vitest run tests/session/SessionManager.test.ts -t "saved model selection when"
```

Expected: FAIL because `startCodexSession` still passes `project.codexArgs` unchanged.

- [ ] **Step 3: Implement effective Codex arg merging**

Add helper methods to `src/session/SessionManager.ts`:

```ts
private async effectiveCodexArgs(chatId: string, project: NonNullable<ReturnType<typeof resolveProject>>): Promise<string[]> {
  const chat = await this.store.getChat(chatId);
  const selection = chat?.modelSelectionsByProject?.[project.id];
  return this.applyModelSelectionToArgs(project.codexArgs, selection);
}

private applyModelSelectionToArgs(args: string[], selection?: SavedModelSelection): string[] {
  if (!selection) {
    return [...args];
  }

  const next: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--model' || arg === '-m') {
      index += 1;
      continue;
    }
    if (arg.startsWith('--model=')) {
      continue;
    }
    if (arg.startsWith('-m=')) {
      continue;
    }
    if (arg === '-c' && args[index + 1]?.startsWith('model_reasoning_effort=')) {
      index += 1;
      continue;
    }
    next.push(arg);
  }

  next.push('--model', selection.model);
  if (selection.reasoningEffort) {
    next.push('-c', `model_reasoning_effort="${selection.reasoningEffort}"`);
  }
  return next;
}
```

Modify `startCodexSession` before `this.runner.start`:

```ts
const effectiveArgs = await this.effectiveCodexArgs(input.chatId, project);
```

Use `effectiveArgs` in runner start:

```ts
args: effectiveArgs,
```

- [ ] **Step 4: Run startup arg tests and verify pass**

Run:

```bash
pnpm vitest run tests/session/SessionManager.test.ts -t "saved model selection when"
```

Expected: PASS.

- [ ] **Step 5: Run focused `/model` suite**

Run:

```bash
pnpm vitest run tests/models/CodexModelCatalog.test.ts tests/commands/CommandRouter.test.ts tests/state/FileStateStore.test.ts tests/session/SessionManager.test.ts -t "model|model selections|saved model selection"
```

Expected: PASS.

- [ ] **Step 6: Commit startup arg integration**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: apply saved model to codex sessions"
```

---

### Task 6: Final Verification and Documentation

**Files:**
- Modify: `README.md`
- Modify: `config.example.json` only if the implementation requires no config changes, leave it untouched and verify no diff exists.

- [ ] **Step 1: Add README command documentation**

Modify the commands section in `README.md` to include:

```md
- `/model [model] [reasoning]`: list Codex-supported models from the local Codex model cache, save a chat/project default, and switch the running Codex session when one is active.
```

Add a config note near the existing Codex args note:

```md
- `/model` reads Codex's local `models_cache.json` and does not require a code_bot model allowlist. Saved model selections are stored in code_bot chat state and override project `--model` args for future sessions.
```

- [ ] **Step 2: Run final focused tests**

Run:

```bash
pnpm vitest run tests/models/CodexModelCatalog.test.ts tests/commands/CommandRouter.test.ts tests/state/FileStateStore.test.ts tests/session/SessionManager.test.ts -t "model|model selections|saved model selection|supports /use, /status, and /tail"
```

Expected: PASS.

- [ ] **Step 3: Run broader related tests**

Run:

```bash
pnpm vitest run tests/codex/CodexRunner.test.ts tests/config/loadConfig.test.ts tests/status/StatusMessageFormatter.test.ts tests/session/SessionManager.test.ts -t "starts Codex|resumes|/status|model|saved model selection"
```

Expected: PASS. If unrelated existing timeout tests appear when running the entire `SessionManager` file, keep the focused command above as the acceptance gate and document the unrelated failure.

- [ ] **Step 4: Commit docs and final verification changes**

```bash
git add README.md
git commit -m "docs: document model command"
```

- [ ] **Step 5: Inspect final branch status**

Run:

```bash
git status --short
git log --oneline -5
```

Expected: only unrelated pre-existing untracked files remain, and recent commits include:

```text
docs: document model command
feat: apply saved model to codex sessions
feat: switch codex model command
feat: list codex models
feat: store chat model selections
feat: read codex model catalog
```

---

## Self-Review

Spec coverage:

- Model list from Codex cache: Task 1 and Task 3.
- No static allowlist: Task 1 reads `models_cache.json`; no config field is introduced.
- `/model` display: Task 3.
- `/model <slug>` and `/model <slug> <reasoning>` validation: Task 3.
- Save per chat/project selection: Task 2 and Task 4.
- Runtime PTY switch: Task 4.
- Future `/new` and `/resume` args: Task 5.
- Reasoning startup handling: Task 5 uses Codex config override `-c model_reasoning_effort="<effort>"`, while runtime switch still uses native `/model`.
- Error handling: Task 1, Task 3, and Task 4.
- Help and README documentation: Task 3 and Task 6.

Placeholder scan:

- The plan contains no unresolved placeholder language and no open implementation gaps.

Type consistency:

- `SavedModelSelection.model`, `SavedModelSelection.reasoningEffort`, and `ChatContext.modelSelectionsByProject` are introduced in Task 2 and used consistently in later tasks.
- `CodexModelCatalog`, `CodexModelInfo`, and `readCodexModelCatalog` are introduced in Task 1 and used consistently in Task 3.
