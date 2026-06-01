# Codex Completion Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactively notify the originating Feishu chat with Codex's final answer after each normal task completes, while preserving `/tail` and `/rawtail`.

**Architecture:** Keep the existing PTY runner and session lifecycle. Add isolated final-answer extraction, an injectable notifier boundary, and in-memory pending turn tracking inside `SessionManager`; completion is detected by stable sanitized output with process-exit fallback.

**Tech Stack:** TypeScript, Vitest, existing `FileStateStore`, existing `CodexRunner`, existing terminal sanitizer/output modules.

---

## File Structure

- Create `src/notifications/FinalAnswerExtractor.ts`: extracts a final answer candidate from sanitized pending-turn output and formats success/failure notification bodies.
- Test `tests/notifications/FinalAnswerExtractor.test.ts`: covers noisy TUI output, Chinese answers, MCP warnings, prompt echo, spinner fragments, and truncation.
- Modify `src/domain/types.ts`: add `NotificationConfig` to `BotConfig`.
- Modify `src/config/loadConfig.ts`: parse optional `notifications` config with defaults.
- Modify `tests/config/loadConfig.test.ts`: verify defaults and custom notification config.
- Modify `tests/helpers/fakes.ts`: add notification defaults to `sampleConfig`.
- Modify `src/app/createApp.ts`: accept optional `notifier` and pass it to `SessionManager`.
- Modify `src/index.ts`: pass `gateway` as notifier when creating the app, while keeping health/recovery behavior intact.
- Modify `tests/app/createApp.test.ts` and `tests/app/bootstrap.test.ts`: cover notifier wiring.
- Modify `src/session/SessionManager.ts`: add pending turn lifecycle, idle timer completion detection, busy rejection, exit fallback, and notifier error logging.
- Modify `tests/session/SessionManager.test.ts`: cover immediate acknowledgement, busy rejection, `/tail` compatibility, completion notify, exit fallback, notifier failure, and disabled-notifications legacy behavior.

---

### Task 1: Final Answer Extractor

**Files:**
- Create: `src/notifications/FinalAnswerExtractor.ts`
- Create: `tests/notifications/FinalAnswerExtractor.test.ts`

- [ ] **Step 1: Write failing extractor tests**

Create `tests/notifications/FinalAnswerExtractor.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { extractFinalAnswer, formatCompletionNotification } from '../../src/notifications/FinalAnswerExtractor.js';

describe('FinalAnswerExtractor', () => {
  it('extracts the final Chinese answer from noisy Codex TUI output', () => {
    const result = extractFinalAnswer({
      rawLines: [
        '\u001b[?2026h╭───────────────────────────────────────╮',
        '│ >_ OpenAI Codex (v0.135.0) │',
        '› 当前分支是什么',
        '• Working',
        'WWo•Wor•WorkWorking',
        '• Ran git branch --show-current',
        '└ develop',
        '────────────────────────────────────────────────────────────────',
        '当前分支：develop',
        '当前提交：079db17d',
        '工作区状态：干净，跟踪 origin/develop。',
      ],
      prompt: '当前分支是什么',
      maxChars: 8000,
    });

    expect(result).toEqual({
      kind: 'answer',
      text: ['当前分支：develop', '当前提交：079db17d', '工作区状态：干净，跟踪 origin/develop。'].join('\n'),
    });
  });

  it('does not treat MCP warnings and startup progress as a successful answer', () => {
    const result = extractFinalAnswer({
      rawLines: [
        'Starting MCP servers (0/7): FeishuProjectMcp, codebase',
        '⚠ The figma MCP server is not logged in. Run `codex mcp login figma`.',
        '⚠ MCP startup incomplete (failed: FeishuProjectMcp, codebase, figma, scm)',
        '› Explain this codebase',
        'gpt-5.5 medium · Context 0% used',
      ],
      prompt: 'Explain this codebase',
      maxChars: 8000,
    });

    expect(result.kind).toBe('empty');
    expect(result.reason).toContain('No final answer');
  });

  it('filters prompt echo and spinner fragments', () => {
    const result = extractFinalAnswer({
      rawLines: [
        '› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
        '只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
        '•Working•orking•rking•king•ingngg',
        '当前目录是 /Users/bytedance/Projects/github/code_bot。',
      ],
      prompt: '只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
      maxChars: 8000,
    });

    expect(result).toEqual({
      kind: 'answer',
      text: '当前目录是 /Users/bytedance/Projects/github/code_bot。',
    });
  });

  it('truncates long final answers with a tail hint', () => {
    const result = extractFinalAnswer({
      rawLines: ['第一行', '第二行', '第三行'],
      prompt: '总结',
      maxChars: 8,
    });

    expect(result.kind).toBe('answer');
    expect(result.text).toBe('第一行\n第二…\n\n输出已截断，可使用 /tail 查看完整内容。');
  });

  it('formats success and failure notifications', () => {
    expect(formatCompletionNotification({ projectId: 'repo', extraction: { kind: 'answer', text: '完成了' } })).toBe(
      'Codex 已完成：repo\n\n完成了',
    );
    expect(
      formatCompletionNotification({
        projectId: 'repo',
        sessionId: 'sess_1',
        extraction: { kind: 'empty', reason: 'No final answer detected.' },
      }),
    ).toBe('Codex 任务结束，但未能提取明确最终回答。\n\n原因：No final answer detected.\n可使用 /tail sess_1 查看最近输出。');
  });
});
```

- [ ] **Step 2: Run extractor tests and verify failure**

Run:

```bash
npm test -- tests/notifications/FinalAnswerExtractor.test.ts
```

Expected: FAIL because `src/notifications/FinalAnswerExtractor.ts` does not exist.

- [ ] **Step 3: Implement extractor**

Create `src/notifications/FinalAnswerExtractor.ts`:

```ts
import { sanitizeTerminalOutput } from '../output/TerminalOutputSanitizer.js';

export type FinalAnswerExtraction =
  | { kind: 'answer'; text: string }
  | { kind: 'empty'; reason: string }
  | { kind: 'failure'; reason: string; diagnostic?: string };

export interface ExtractFinalAnswerInput {
  rawLines: string[];
  prompt?: string;
  maxChars: number;
}

export function extractFinalAnswer(input: ExtractFinalAnswerInput): FinalAnswerExtraction {
  const sanitized = sanitizeTerminalOutput(input.rawLines);
  const prompt = normalizeComparable(input.prompt ?? '');
  const lines = sanitized.readableLines
    .flatMap((line) => line.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !isProcessLine(line))
    .filter((line) => normalizeComparable(line) !== prompt)
    .filter((line) => !line.startsWith(`› ${input.prompt ?? ''}`));

  const answerLines = dropCommandTranscript(lines);
  if (answerLines.length === 0) {
    return { kind: 'empty', reason: 'No final answer detected.' };
  }

  return { kind: 'answer', text: truncateWithTailHint(answerLines.join('\n').trim(), input.maxChars) };
}

export function formatCompletionNotification(input: {
  projectId: string;
  sessionId?: string;
  extraction: FinalAnswerExtraction;
}): string {
  if (input.extraction.kind === 'answer') {
    return `Codex 已完成：${input.projectId}\n\n${input.extraction.text}`;
  }
  const diagnostic = input.extraction.kind === 'failure' && input.extraction.diagnostic ? `\n\n${input.extraction.diagnostic}` : '';
  const tailCommand = input.sessionId ? `/tail ${input.sessionId}` : '/tail';
  return `Codex 任务结束，但未能提取明确最终回答。\n\n原因：${input.extraction.reason}${diagnostic}\n可使用 ${tailCommand} 查看最近输出。`;
}

function isProcessLine(line: string): boolean {
  return (
    line.includes('OpenAI Codex') ||
    line.startsWith('Tip:') ||
    line.startsWith('Starting MCP servers') ||
    line.startsWith('Booting MCP server') ||
    line.startsWith('⚠ The ') ||
    line.startsWith('⚠ MCP ') ||
    line.startsWith('gpt-') ||
    line.includes('Context ') ||
    line.includes('weekly ') ||
    line.includes('esc to interrupt') ||
    /^•\s*Working/.test(line) ||
    /^W*o*r*k*i*n*g*\d*$/.test(line.replace(/[•\s]/g, '')) ||
    /^[-─]{8,}$/.test(line)
  );
}

function dropCommandTranscript(lines: string[]): string[] {
  const lastDividerIndex = lines.findLastIndex((line) => /^[-─]{8,}$/.test(line));
  const scoped = lastDividerIndex >= 0 ? lines.slice(lastDividerIndex + 1) : lines;
  return scoped.filter((line) => !line.startsWith('• Ran ') && !line.startsWith('└ '));
}

function normalizeComparable(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

function truncateWithTailHint(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = '\n\n输出已截断，可使用 /tail 查看完整内容。';
  return `${text.slice(0, Math.max(1, maxChars - suffix.length))}…${suffix}`;
}
```

- [ ] **Step 4: Run extractor tests and fix compile issues only**

Run:

```bash
npm test -- tests/notifications/FinalAnswerExtractor.test.ts
```

Expected: PASS. If TypeScript target lacks `findLastIndex`, replace it with a reverse loop:

```ts
let lastDividerIndex = -1;
for (let index = lines.length - 1; index >= 0; index -= 1) {
  if (/^[-─]{8,}$/.test(lines[index])) {
    lastDividerIndex = index;
    break;
  }
}
```

- [ ] **Step 5: Commit extractor**

```bash
git add src/notifications/FinalAnswerExtractor.ts tests/notifications/FinalAnswerExtractor.test.ts
git commit -m "feat: extract codex final answers"
```

---

### Task 2: Notification Config

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/config/loadConfig.ts`
- Modify: `tests/config/loadConfig.test.ts`
- Modify: `tests/helpers/fakes.ts`

- [ ] **Step 1: Write failing config tests**

Add to `tests/config/loadConfig.test.ts`:

```ts
it('defaults notification config when omitted', async () => {
  const root = await createTmpDir();
  await writeConfig(root, {
    feishu: { appId: 'cli', appSecret: 'secret' },
    allowedUsers: ['ou_1'],
    allowedChatIds: ['oc_1'],
    projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
    output: { directMaxChars: 1800, chunkSize: 1500 },
    codex: { command: 'codex', defaultArgs: [] },
  });

  await expect(loadConfig(root)).resolves.toMatchObject({
    notifications: {
      enabled: true,
      idleMs: 3000,
      maxFinalChars: 8000,
      failureTailChars: 2000,
    },
  });
});

it('loads custom notification config', async () => {
  const root = await createTmpDir();
  await writeConfig(root, {
    feishu: { appId: 'cli', appSecret: 'secret' },
    allowedUsers: ['ou_1'],
    allowedChatIds: ['oc_1'],
    projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
    output: { directMaxChars: 1800, chunkSize: 1500 },
    codex: { command: 'codex', defaultArgs: [] },
    notifications: { enabled: false, idleMs: 50, maxFinalChars: 1000, failureTailChars: 500 },
  });

  await expect(loadConfig(root)).resolves.toMatchObject({
    notifications: { enabled: false, idleMs: 50, maxFinalChars: 1000, failureTailChars: 500 },
  });
});
```

- [ ] **Step 2: Run config tests and verify failure**

```bash
npm test -- tests/config/loadConfig.test.ts
```

Expected: FAIL because `BotConfig` has no `notifications` field or loader defaults.

- [ ] **Step 3: Add types and loader defaults**

In `src/domain/types.ts`, add:

```ts
export interface NotificationConfig {
  enabled: boolean;
  idleMs: number;
  maxFinalChars: number;
  failureTailChars: number;
}
```

Then add to `BotConfig`:

```ts
notifications: NotificationConfig;
```

In `src/config/loadConfig.ts`, add:

```ts
function optionalBoolean(value: unknown, defaultValue: boolean, field: string): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  return requirePositiveNumber(value, field);
}
```

Inside `loadConfig`, read:

```ts
const notifications = (record.notifications as Record<string, unknown> | undefined) ?? {};
```

Return:

```ts
notifications: {
  enabled: optionalBoolean(notifications.enabled, true, 'notifications.enabled'),
  idleMs: optionalPositiveNumber(notifications.idleMs, 3000, 'notifications.idleMs'),
  maxFinalChars: optionalPositiveNumber(notifications.maxFinalChars, 8000, 'notifications.maxFinalChars'),
  failureTailChars: optionalPositiveNumber(notifications.failureTailChars, 2000, 'notifications.failureTailChars'),
},
```

In `tests/helpers/fakes.ts`, add to `sampleConfig`:

```ts
notifications: { enabled: true, idleMs: 10, maxFinalChars: 8000, failureTailChars: 2000 },
```

- [ ] **Step 4: Run config tests**

```bash
npm test -- tests/config/loadConfig.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit config**

```bash
git add src/domain/types.ts src/config/loadConfig.ts tests/config/loadConfig.test.ts tests/helpers/fakes.ts
git commit -m "feat: add completion notification config"
```

---

### Task 3: Notifier Wiring

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `src/app/createApp.ts`
- Modify: `src/index.ts`
- Modify: `tests/app/createApp.test.ts`
- Modify: `tests/app/bootstrap.test.ts`

- [ ] **Step 1: Write failing wiring tests**

Add to `tests/app/createApp.test.ts`:

```ts
it('passes notifier dependency to SessionManager', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = { sendText: vi.fn() };

  const app = createApp({ projectRoot: root, config: sampleConfig(root), store, codexRunner: runner, notifier });

  await app.sessionManager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sent = await app.sessionManager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'hello' });
  expect(sent.reply).toContain('已发送给 Codex');
});
```

Add to `tests/app/bootstrap.test.ts`:

```ts
it('creates the app with the Feishu gateway as notifier', async () => {
  const gateway = { start: vi.fn(), sendText: vi.fn() };
  const createApp = vi.fn().mockReturnValue({
    sessionManager: { handleText: vi.fn().mockResolvedValue({ reply: 'ok' }) },
    healthCheck: vi.fn().mockResolvedValue({ ok: true }),
    recoverStartupState: vi.fn().mockResolvedValue(undefined),
  });

  await bootstrap({
    projectRoot: '/tmp/code-bot',
    loadConfig: vi.fn().mockResolvedValue(sampleConfig('/tmp/code-bot')),
    createStore: vi.fn().mockReturnValue({ appendEvent: vi.fn() }),
    createCodexRunner: vi.fn().mockReturnValue(new FakeCodexRunner()),
    createGateway: vi.fn().mockReturnValue(gateway),
    createApp,
  } as any);

  expect(createApp).toHaveBeenCalledWith(expect.objectContaining({ notifier: gateway }));
});
```

- [ ] **Step 2: Run app tests and verify failure**

```bash
npm test -- tests/app/createApp.test.ts tests/app/bootstrap.test.ts
```

Expected: FAIL because `AppDependencies` and `BootstrapDeps.createApp` do not accept `notifier`.

- [ ] **Step 3: Add notifier interfaces and wiring**

In `src/session/SessionManager.ts`, export:

```ts
export interface Notifier {
  sendText(chatId: string, text: string): Promise<void>;
}
```

Extend `SessionManagerDeps`:

```ts
notifier?: Notifier;
```

In `src/app/createApp.ts`, extend `AppDependencies`:

```ts
notifier?: Notifier;
```

Import `Notifier` from `SessionManager`, and instantiate:

```ts
sessionManager: new SessionManager(deps.config, deps.store, deps.codexRunner, { notifier: deps.notifier }),
```

In `src/index.ts`, extend `BootstrapDeps.createApp` args with:

```ts
notifier?: FeishuGateway;
```

Move gateway creation before `createApp`:

```ts
const gateway = createGatewayFn(config.feishu.appId, config.feishu.appSecret);
const app = createAppFn({ projectRoot, config, store, codexRunner, notifier: gateway });
```

Keep:

```ts
await gateway.start((message) => app.sessionManager.handleText(message).then((result) => result.reply));
```

- [ ] **Step 4: Run wiring tests**

```bash
npm test -- tests/app/createApp.test.ts tests/app/bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit wiring**

```bash
git add src/session/SessionManager.ts src/app/createApp.ts src/index.ts tests/app/createApp.test.ts tests/app/bootstrap.test.ts
git commit -m "feat: wire completion notifier"
```

---

### Task 4: Pending Turn Lifecycle and Busy Rejection

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing session lifecycle tests**

Add to `tests/session/SessionManager.test.ts`:

```ts
it('acknowledges normal tasks immediately when notifications are enabled', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
  const manager = new SessionManager(sampleConfig(root), store, runner, { notifier });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

  const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });

  expect(sent.reply).toBe(`已发送给 Codex，完成后我会主动通知你。\nsession: ${sessionId}`);
  expect(runner.sentMessages).toEqual(['inspect status']);
  expect(notifier.sendText).not.toHaveBeenCalled();
});

it('rejects a second normal task while a pending notified turn is active', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: { sendText: vi.fn() } });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first task' });
  const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second task' });

  expect(second.reply).toBe('当前 session 正在执行任务，请等待完成后再发送新任务，或使用 /tail 查看进度。');
  expect(runner.sentMessages).toEqual(['first task']);
});

it('keeps /tail available while a pending notified turn is active', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, { notifier: { sendText: vi.fn() } });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first task' });
  await runner.emitOutput(sessionId, 'partial output\n');

  const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 10' });

  expect(tail.reply).toBe('partial output');
});

it('uses legacy send reply when notifications are disabled', async () => {
  const root = await createTmpDir();
  const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, enabled: false } };
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(config, store, runner, { notifier: { sendText: vi.fn() } });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  const sent = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'inspect status' });

  expect(sent.reply).toBe(`Sent to Codex session ${sessionId}.`);
  expect(runner.sentMessages).toEqual(['inspect status']);
});
```

- [ ] **Step 2: Run session tests and verify failure**

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: FAIL because normal tasks still return the legacy reply and no busy state exists.

- [ ] **Step 3: Implement pending turn creation and busy rejection**

In `src/session/SessionManager.ts`, add near constants:

```ts
interface PendingTurn {
  id: string;
  sessionId: string;
  chatId: string;
  projectId: string;
  prompt: string;
  startedAt: string;
  outputStartIndex: number;
  notified: boolean;
  lastCandidate?: string;
  timer?: ReturnType<typeof setTimeout>;
}
```

Add class field:

```ts
private readonly pendingTurns = new Map<string, PendingTurn>();
```

Add helper:

```ts
private notificationsEnabled(): boolean {
  return this.config.notifications.enabled && !!this.deps.notifier;
}
```

Update `sendToCurrentSession(chatId, text)` to accept full input:

```ts
private async sendToCurrentSession(input: IncomingBotText, text: string): Promise<BotTextResult> {
```

Update callers:

```ts
return this.sendToCurrentSession(input, parsed.text);
return this.sendToCurrentSession(input, parsed.args[0] ?? '');
```

Inside `sendToCurrentSession`, after loading the running session and before `runner.send`:

```ts
if (this.notificationsEnabled() && this.pendingTurns.has(chat.currentSessionId)) {
  await this.store.appendEvent({
    type: 'notification.turn_busy_rejected',
    at: new Date().toISOString(),
    data: { sessionId: chat.currentSessionId, chatId: input.chatId },
  });
  return { reply: '当前 session 正在执行任务，请等待完成后再发送新任务，或使用 /tail 查看进度。' };
}
```

Before the existing `try { await this.runner.send(...) }` block, create a pending turn only when enabled so output produced immediately during send is attributed to the turn:

```ts
const notificationEnabled = this.notificationsEnabled();
const notificationStartedAt = new Date().toISOString();
if (notificationEnabled) {
  const outputStartIndex = (await this.store.tailSessionLog(chat.currentSessionId, 100000)).length;
  this.pendingTurns.set(chat.currentSessionId, {
    id: `${chat.currentSessionId}:${Date.now()}`,
    sessionId: chat.currentSessionId,
    chatId: input.chatId,
    projectId: session.projectId,
    prompt: text,
    startedAt: notificationStartedAt,
    outputStartIndex,
    notified: false,
  });
}
```

Inside the existing `catch (error)` block for `runner.send`, before updating the session, add:

```ts
this.pendingTurns.delete(chat.currentSessionId);
```

After successful `runner.send`, return the notification acknowledgement when enabled:

```ts
if (notificationEnabled) {
  await this.store.appendEvent({
    type: 'notification.turn_started',
    at: notificationStartedAt,
    data: { sessionId: chat.currentSessionId, chatId: input.chatId, projectId: session.projectId },
  });
  return { reply: `已发送给 Codex，完成后我会主动通知你。\nsession: ${chat.currentSessionId}` };
}
```

Keep the existing legacy event and reply for disabled notifications:

```ts
await this.store.appendEvent({
  type: 'session.input',
  at: new Date().toISOString(),
  data: { sessionId: chat.currentSessionId },
});
return { reply: `Sent to Codex session ${chat.currentSessionId}.` };
```

- [ ] **Step 4: Run session lifecycle tests**

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: PASS for the new lifecycle tests. Existing tests that asserted `Sent to Codex` may need to be updated only when they use default enabled notifications; keep disabled-config coverage for legacy behavior.

- [ ] **Step 5: Commit lifecycle**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: track pending codex turns"
```

---

### Task 5: Stable Completion Notification

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing completion tests**

Add to `tests/session/SessionManager.test.ts`:

```ts
it('sends one proactive notification when final answer output stabilizes', async () => {
  vi.useFakeTimers();
  try {
    const root = await createTmpDir();
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const manager = new SessionManager(config, store, runner, { notifier });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '当前分支是什么' });

    await runner.emitOutput(sessionId, '• Working\n');
    await runner.emitOutput(sessionId, '当前分支：develop\n');
    await vi.advanceTimersByTimeAsync(49);
    expect(notifier.sendText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(notifier.sendText).toHaveBeenCalledTimes(1);
    expect(notifier.sendText).toHaveBeenCalledWith('oc_1', 'Codex 已完成：repo\n\n当前分支：develop');
  } finally {
    vi.useRealTimers();
  }
});

it('allows a new task after the prior turn notification is sent', async () => {
  vi.useFakeTimers();
  try {
    const root = await createTmpDir();
    const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 1 } };
    const store = new FileStateStore(root);
    const runner = new FakeCodexRunner();
    const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
    const manager = new SessionManager(config, store, runner, { notifier });

    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
    const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
    await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'first' });
    await runner.emitOutput(sessionId, 'first answer\n');
    await vi.advanceTimersByTimeAsync(1);

    const second = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'second' });
    expect(second.reply).toBe(`已发送给 Codex，完成后我会主动通知你。\nsession: ${sessionId}`);
    expect(runner.sentMessages).toEqual(['first', 'second']);
  } finally {
    vi.useRealTimers();
  }
});
```

- [ ] **Step 2: Run completion tests and verify failure**

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: FAIL because output does not trigger notifications.

- [ ] **Step 3: Implement stable completion detection**

In `src/session/SessionManager.ts`, import:

```ts
import { extractFinalAnswer, formatCompletionNotification } from '../notifications/FinalAnswerExtractor.js';
```

Modify `appendSessionOutput`:

```ts
private async appendSessionOutput(sessionId: string, text: string): Promise<void> {
  await this.store.appendSessionLog(sessionId, text);
  await this.observePendingTurnOutput(sessionId);
}
```

Add:

```ts
private async observePendingTurnOutput(sessionId: string): Promise<void> {
  const turn = this.pendingTurns.get(sessionId);
  if (!turn || turn.notified) {
    return;
  }
  const lines = await this.store.tailSessionLog(sessionId, 100000);
  const pendingLines = lines.slice(turn.outputStartIndex);
  const extraction = extractFinalAnswer({
    rawLines: pendingLines,
    prompt: turn.prompt,
    maxChars: this.config.notifications.maxFinalChars,
  });
  if (extraction.kind !== 'answer') {
    return;
  }
  if (turn.lastCandidate !== extraction.text) {
    turn.lastCandidate = extraction.text;
    if (turn.timer) {
      clearTimeout(turn.timer);
    }
    await this.store.appendEvent({
      type: 'notification.answer_candidate_updated',
      at: new Date().toISOString(),
      data: { sessionId, chatId: turn.chatId },
    });
  }
  turn.timer = setTimeout(() => {
    void this.completePendingTurn(sessionId, 'stable').catch((error) =>
      this.recordBackgroundError('notification.send_failed', error, { sessionId }).catch(() => undefined),
    );
  }, this.config.notifications.idleMs);
}

private async completePendingTurn(sessionId: string, reason: 'stable' | 'exit'): Promise<void> {
  const turn = this.pendingTurns.get(sessionId);
  if (!turn || turn.notified) {
    return;
  }
  turn.notified = true;
  if (turn.timer) {
    clearTimeout(turn.timer);
  }
  const lines = await this.store.tailSessionLog(sessionId, 100000);
  const extraction = extractFinalAnswer({
    rawLines: lines.slice(turn.outputStartIndex),
    prompt: turn.prompt,
    maxChars: this.config.notifications.maxFinalChars,
  });
  const message = formatCompletionNotification({ projectId: turn.projectId, sessionId, extraction });
  await this.deps.notifier!.sendText(turn.chatId, message);
  this.pendingTurns.delete(sessionId);
  await this.store.appendEvent({
    type: reason === 'exit' ? 'notification.turn_exit_fallback' : 'notification.turn_completed',
    at: new Date().toISOString(),
    data: { sessionId, chatId: turn.chatId, projectId: turn.projectId, extraction: extraction.kind },
  });
}
```

- [ ] **Step 4: Run completion tests**

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: PASS for completion tests. If fake timers need pending promise flushing, use `await vi.runOnlyPendingTimersAsync()`.

- [ ] **Step 5: Commit completion detection**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: notify when codex output stabilizes"
```

---

### Task 6: Exit Fallback and Notifier Failure Handling

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write failing fallback tests**

Add to `tests/session/SessionManager.test.ts`:

```ts
it('sends an exit fallback notification for a pending turn', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
  const manager = new SessionManager(sampleConfig(root), store, runner, { notifier });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'summarize' });
  await runner.emitOutput(sessionId, '最终结果\n');
  await runner.exit(sessionId, 0);

  expect(notifier.sendText).toHaveBeenCalledWith('oc_1', 'Codex 已完成：repo\n\n最终结果');
});

it('sends a failure-style fallback when exit has no final answer', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
  const manager = new SessionManager(sampleConfig(root), store, runner, { notifier });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'summarize' });
  await runner.emitOutput(sessionId, '• Working\n');
  await runner.exit(sessionId, 1);

  expect(notifier.sendText).toHaveBeenCalledWith(
    'oc_1',
    `Codex 任务结束，但未能提取明确最终回答。\n\n原因：No final answer detected.\n可使用 /tail ${sessionId} 查看最近输出。`,
  );
});

it('records notifier failures without throwing through output handling', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = { sendText: vi.fn().mockRejectedValue(new Error('feishu unavailable')) };
  const manager = new SessionManager(sampleConfig(root), store, runner, { notifier });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'summarize' });
  await runner.emitOutput(sessionId, '最终结果\n');
  await runner.exit(sessionId, 0);

  const day = new Date().toISOString().slice(0, 10);
  const content = await readFile(join(root, '.code-bot', 'events', `${day}.jsonl`), 'utf8');
  expect(content).toContain('"type":"notification.send_failed"');
  expect(content).toContain('"reason":"feishu unavailable"');
});
```

- [ ] **Step 2: Run fallback tests and verify failure**

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: FAIL because `markExited` does not complete pending turns.

- [ ] **Step 3: Implement exit fallback and robust notifier failure**

At the end of `markExited`, add:

```ts
if (this.pendingTurns.has(sessionId)) {
  await this.completePendingTurn(sessionId, 'exit').catch((error) =>
    this.recordBackgroundError('notification.send_failed', error, { sessionId }),
  );
}
```

In `completePendingTurn`, move `this.pendingTurns.delete(sessionId)` into a `finally` so failed sends do not leave the session permanently busy:

```ts
try {
  await this.deps.notifier!.sendText(turn.chatId, message);
  await this.store.appendEvent({
    type: reason === 'exit' ? 'notification.turn_exit_fallback' : 'notification.turn_completed',
    at: new Date().toISOString(),
    data: { sessionId, chatId: turn.chatId, projectId: turn.projectId, extraction: extraction.kind },
  });
} finally {
  this.pendingTurns.delete(sessionId);
}
```

- [ ] **Step 4: Run fallback tests**

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit fallback handling**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: add codex notification fallback"
```

---

### Task 7: User Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Validate: all changed source and tests.

- [ ] **Step 1: Document completion notifications**

In `README.md`, add this bullet to the config section after the `codex.defaultArgs` bullet:

```md
- Configure `notifications.enabled`, `notifications.idleMs`, `notifications.maxFinalChars`, and `notifications.failureTailChars` to control proactive completion messages. Notifications are enabled by default.
```

Add this note after the paragraph about plain text messages:

```md
With completion notifications enabled, plain text messages receive an immediate acknowledgement, then the bot sends a second Feishu message when Codex's final answer is detected. Use `/tail` or `/rawtail` to inspect process output while a task is running.
```

- [ ] **Step 2: Run focused tests**

```bash
npm test -- tests/notifications/FinalAnswerExtractor.test.ts tests/session/SessionManager.test.ts tests/config/loadConfig.test.ts tests/app/createApp.test.ts tests/app/bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Run TypeScript build**

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Inspect git diff**

```bash
git diff --stat
git diff --check
```

Expected: `git diff --check` exits cleanly. Diff should only include notification feature files, tests, and README docs.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md
git commit -m "docs: document completion notifications"
```
