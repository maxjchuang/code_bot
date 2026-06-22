# Final Answer Format Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve blank lines and indentation for structured Codex observation final answers in completion notifications.

**Architecture:** Add an observation-only preservation helper in `SessionManager.ts` and route `currentTurnObservationExtraction()` through it instead of `extractFinalAnswer()`. Keep PTY fallback extraction unchanged so terminal noise cleanup continues to use `FinalAnswerExtractor`.

**Tech Stack:** TypeScript, Vitest, existing `SessionManager`, `FakeCodexRunner`, and `FakeCodexObservationStore` test helpers.

---

## File Structure

- Modify `src/session/SessionManager.ts`: add `preserveStructuredFinalAnswer()` and update `currentTurnObservationExtraction()` to use it.
- Modify `tests/session/SessionManager.test.ts`: add focused regression tests for structured observation formatting and PTY fallback behavior.

---

### Task 1: Add failing tests for observation formatting preservation

**Files:**
- Modify: `tests/session/SessionManager.test.ts`

- [x] **Step 1: Add a helper for observation completion tests**

Insert this helper near existing top-level helpers, after `createNotifierWithReactions()`:

```ts
async function completeFromObservation(input: {
  finalAnswer: string;
  prompt?: string;
}): Promise<{
  notifier: { sendText: ReturnType<typeof vi.fn> };
}> {
  vi.useFakeTimers();
  const root = await createTmpDir();
  const config = { ...sampleConfig(root), notifications: { ...sampleConfig(root).notifications, idleMs: 50 } };
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const notifier = { sendText: vi.fn().mockResolvedValue(undefined) };
  const observationStore = new FakeCodexObservationStore();
  const manager = new SessionManager(config, store, runner, { notifier, codexObservationStore: observationStore });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  const codexSessionId = '019e86b4-12ed-7731-9639-c128626a3406';
  await store.updateSession(sessionId, (latest) => ({ ...latest, codexSessionId }));
  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: input.prompt ?? 'format response' });

  observationStore.snapshots.set(codexSessionId, {
    availability: { kind: 'ready' },
    codexSessionId,
    status: 'completed',
    finalAnswer: input.finalAnswer,
    completedAt: '2099-06-02T08:00:00.000Z',
    recentToolEvents: [],
  });

  await runner.emitOutput(sessionId, 'tick\n');
  await vi.advanceTimersByTimeAsync(50);
  vi.useRealTimers();
  await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));

  return { notifier };
}
```

- [x] **Step 2: Add the blank-line preservation test**

Add this test near the existing stable completion tests:

```ts
it('preserves blank lines in observation final answers', async () => {
  try {
    const { notifier } = await completeFromObservation({
      finalAnswer: '方案 1\n\n**方案 2**\n\n结论',
    });

    expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '方案 1\n\n**方案 2**\n\n结论');
  } finally {
    vi.useRealTimers();
  }
});
```

- [x] **Step 3: Add the indentation preservation test**

Add this test after the blank-line test:

```ts
it('preserves indentation in observation final answers', async () => {
  try {
    const { notifier } = await completeFromObservation({
      finalAnswer: '代码:\n\n    const value = 1;\n    return value;',
    });

    expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '代码:\n\n    const value = 1;\n    return value;');
  } finally {
    vi.useRealTimers();
  }
});
```

- [x] **Step 4: Verify the new tests fail**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "preserves .* observation final answers"
```

Expected: both new tests FAIL because the current observation path removes blank lines and trims indentation through `extractFinalAnswer()`.

---

### Task 2: Implement structured observation preservation

**Files:**
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [x] **Step 1: Add the preservation helper**

Add this helper near `previewCandidate()` at the bottom of `src/session/SessionManager.ts`:

```ts
function preserveStructuredFinalAnswer(input: {
  text: string;
  prompt: string;
  maxChars: number;
}): string | undefined {
  const normalized = input.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  if (!normalized) {
    return undefined;
  }

  const withoutPromptEcho = dropStandalonePromptEcho(normalized, input.prompt);
  if (!withoutPromptEcho) {
    return undefined;
  }

  return truncateWithTailHint(withoutPromptEcho, input.maxChars);
}

function dropStandalonePromptEcho(text: string, prompt: string): string {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return text;
  }

  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== normalizedPrompt) {
    return text;
  }

  return lines.slice(1).join('\n').trim();
}

function truncateWithTailHint(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const suffix = '\n\n输出已截断，可使用 /tail 查看完整内容。';
  const prefixLength = maxChars - suffix.length - 1;
  if (prefixLength <= 0) {
    return `…${suffix}`.slice(0, Math.max(0, maxChars));
  }
  return `${text.slice(0, prefixLength)}…${suffix}`;
}
```

- [x] **Step 2: Route observation answers through the helper**

Replace this block in `currentTurnObservationExtraction()`:

```ts
const extraction = extractFinalAnswer({
  rawLines: finalAnswer.split('\n'),
  prompt: turn.prompt,
  maxChars: this.config.notifications.maxFinalChars,
  requireCompletionMarker: false,
});
return extraction.kind === 'answer' ? extraction : undefined;
```

with:

```ts
const preserved = preserveStructuredFinalAnswer({
  text: finalAnswer,
  prompt: turn.prompt,
  maxChars: this.config.notifications.maxFinalChars,
});
return preserved ? { kind: 'answer', text: preserved } : undefined;
```

- [x] **Step 3: Verify the observation preservation tests pass**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "preserves .* observation final answers"
```

Expected: PASS.

---

### Task 3: Protect PTY fallback behavior

**Files:**
- Modify: `tests/session/SessionManager.test.ts`

- [x] **Step 1: Add a PTY fallback regression test**

Add this test near existing PTY completion extraction tests:

```ts
it('continues to clean PTY final answer noise', async () => {
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

    await runner.emitOutput(
      sessionId,
      [
        '› 当前分支是什么',
        '• Working',
        '• Ran git rev-parse --abbrev-ref HEAD',
        '└ main',
        '────────────────────────────────────────────────────────────────',
        '',
        '当前分支是 `main`。',
        '',
        'gpt-5.5 medium · Context 1% used',
      ].join('\n'),
    );
    await vi.advanceTimersByTimeAsync(50);
    vi.useRealTimers();

    await waitForAssertion(() => expect(notifier.sendText).toHaveBeenCalledTimes(1));
    expect(notifier.sendText).toHaveBeenCalledWith('oc_1', '当前分支是 `main`。');
  } finally {
    vi.useRealTimers();
  }
});
```

- [x] **Step 2: Verify the PTY regression test passes**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "continues to clean PTY final answer noise"
```

Expected: PASS.

---

### Task 4: Run verification and commit

**Files:**
- Verify all modified files.

- [x] **Step 1: Run focused SessionManager tests**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: PASS.

- [x] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

Actual: ran `npm test`; target-related tests passed, but the full suite hit the existing async `records notifier failures without throwing through exit handling` flaky once. Re-running that test alone passed.

- [x] **Step 3: Run typecheck build**

Run:

```bash
npm run build
```

Expected: PASS.

- [x] **Step 4: Review diff**

Run:

```bash
git diff -- src/session/SessionManager.ts tests/session/SessionManager.test.ts docs/superpowers/plans/2026-06-22-final-answer-format-preservation.md
```

Expected: diff only contains the planned helper, routing change, and tests.

- [ ] **Step 5: Commit implementation**

Run:

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts docs/superpowers/plans/2026-06-22-final-answer-format-preservation.md
git commit -m "fix: preserve structured final answer formatting"
```

Expected: commit succeeds.
