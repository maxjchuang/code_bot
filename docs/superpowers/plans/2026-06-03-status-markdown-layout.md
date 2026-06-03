# `/status` Markdown Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/status` render as a Feishu-friendly Markdown card layout while preserving the existing status data, fallback behavior, and plain-text compatibility.

**Architecture:** Add a dedicated status message formatter that converts local session data plus Codex status output into `{ bodyMarkdown, fallbackText }`. Keep Codex status fetching, caching, and parsing unchanged; only `SessionManager` integration and `/status` rendering should change.

**Tech Stack:** TypeScript, Vitest, existing `SessionManager`, `FeishuMessageRenderer`, `CodexStatusService`

---

## File Structure

- Create: `src/status/StatusMessageFormatter.ts`
  Build the `/status` Markdown body and plain-text fallback from structured local and Codex status inputs.
- Modify: `src/session/SessionManager.ts`
  Replace the current line-joined `/status` string with formatter-driven output and explicit `renderedReply`.
- Create: `tests/status/StatusMessageFormatter.test.ts`
  Lock down Markdown layout, empty-field omission, raw block behavior, and fallback text.
- Modify: `tests/session/SessionManager.test.ts`
  Verify `/status` returns a custom rendered Markdown reply and keeps fallback text readable.

### Task 1: Add the dedicated `/status` message formatter

**Files:**
- Create: `src/status/StatusMessageFormatter.ts`
- Test: `tests/status/StatusMessageFormatter.test.ts`

- [ ] **Step 1: Write the failing formatter tests**

```ts
import { describe, expect, it } from 'vitest';
import { formatStatusMessage } from '../../src/status/StatusMessageFormatter.js';

describe('formatStatusMessage', () => {
  it('renders Session, Codex, and Raw sections for a fully populated status', () => {
    const message = formatStatusMessage({
      session: {
        projectId: 'repo',
        sessionId: 'sess_123',
        status: 'running',
        summary: 'recent work summary',
        pendingApprovals: ['ap_1'],
      },
      codex: {
        kind: 'available',
        status: {
          source: 'live',
          fetchedAt: '2026-06-03T10:00:00.000Z',
          rawText: 'Status: running\nTask: Implement status integration',
          summary: {
            statusLine: 'running',
            currentTask: 'Implement status integration',
            model: 'gpt-5-codex',
          },
        },
      },
    });

    expect(message.bodyMarkdown).toContain('## Session');
    expect(message.bodyMarkdown).toContain('## Codex');
    expect(message.bodyMarkdown).toContain('## Raw');
    expect(message.bodyMarkdown).toContain('- **Project**: `repo`');
    expect(message.bodyMarkdown).toContain('- **Task**: Implement status integration');
    expect(message.bodyMarkdown).toContain('```text');
    expect(message.fallbackText).toContain('Project: repo');
  });

  it('omits empty optional local fields and shows Codex unavailable', () => {
    const message = formatStatusMessage({
      session: {
        projectId: 'repo',
        sessionId: 'sess_123',
        status: 'running',
        summary: undefined,
        pendingApprovals: [],
      },
      codex: { kind: 'unavailable' },
    });

    expect(message.bodyMarkdown).toContain('## Session');
    expect(message.bodyMarkdown).not.toContain('Summary');
    expect(message.bodyMarkdown).not.toContain('Pending approvals');
    expect(message.bodyMarkdown).toContain('## Codex\nUnavailable');
    expect(message.bodyMarkdown).not.toContain('## Raw');
  });
});
```

- [ ] **Step 2: Run the formatter test to verify it fails**

Run: `npx vitest run tests/status/StatusMessageFormatter.test.ts`

Expected: FAIL with module-not-found or export-not-found errors for `StatusMessageFormatter`.

- [ ] **Step 3: Implement the formatter**

```ts
import type { CachedCodexStatus, SessionStatus } from '../domain/types.js';

type StatusMessageInput = {
  session: {
    projectId?: string;
    sessionId?: string;
    status?: SessionStatus | 'none';
    summary?: string;
    pendingApprovals: string[];
  };
  codex:
    | { kind: 'available'; status: CachedCodexStatus }
    | { kind: 'unavailable' };
};

export function formatStatusMessage(input: StatusMessageInput): { bodyMarkdown: string; fallbackText: string } {
  const markdownSections = [
    formatSessionMarkdown(input.session),
    formatCodexMarkdown(input.codex),
    formatRawMarkdown(input.codex),
  ].filter(Boolean);

  const fallbackSections = [
    formatSessionFallback(input.session),
    formatCodexFallback(input.codex),
  ].filter(Boolean);

  return {
    bodyMarkdown: markdownSections.join('\n\n'),
    fallbackText: fallbackSections.join('\n\n'),
  };
}
```

- [ ] **Step 4: Run the formatter test to verify it passes**

Run: `npx vitest run tests/status/StatusMessageFormatter.test.ts`

Expected: PASS with the Markdown structure and omission behavior verified.

- [ ] **Step 5: Commit**

```bash
git add src/status/StatusMessageFormatter.ts tests/status/StatusMessageFormatter.test.ts
git commit -m "feat: add status markdown message formatter"
```

### Task 2: Integrate the formatter into `/status`

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
it('returns a custom rendered markdown reply for /status', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    codexStatus: { liveFetchTimeoutMs: 100, quietMs: 0 },
  });

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  runner.queueStatusResponse(sessionId, 'status\r\nStatus: running\r\nTask: Implement status integration\r\n');

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });

  expect(result.renderedReply?.preferred.kind).toBe('card');
  if (result.renderedReply?.preferred.kind !== 'card') {
    throw new Error('expected a card payload');
  }
  expect(JSON.stringify(result.renderedReply.preferred.payload)).toContain('## Session');
  expect(JSON.stringify(result.renderedReply.preferred.payload)).toContain('## Codex');
  expect(JSON.stringify(result.renderedReply.preferred.payload)).toContain('## Raw');
  expect(result.reply).toContain('Project: repo');
});
```

- [ ] **Step 2: Run the focused integration test to verify it fails**

Run: `npx vitest run tests/session/SessionManager.test.ts -t "custom rendered markdown reply for /status"`

Expected: FAIL because `/status` still relies on the generic reply-to-Markdown bridge.

- [ ] **Step 3: Integrate the formatter and explicit rendered reply**

```ts
private async status(chatId: string): Promise<BotTextResult> {
  const chat = await this.store.getChat(chatId);
  const session = chat?.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
  const pendingApprovals = await this.store.listPendingApprovalsByChat(chatId);
  const codexResult = await this.codexStatusResult(session);
  const message = formatStatusMessage({
    session: {
      projectId: chat?.currentProjectId,
      sessionId: chat?.currentSessionId,
      status: session?.status ?? 'none',
      summary: session?.lastSummary,
      pendingApprovals: pendingApprovals.map((approval) => approval.id),
    },
    codex: codexResult,
  });

  return {
    reply: message.fallbackText,
    renderedReply: renderFeishuMessage(
      {
        kind: 'reply',
        bodyMarkdown: message.bodyMarkdown,
        fallbackText: message.fallbackText,
      },
      { verbosity: this.uiVerbosity() },
    ),
  };
}
```

- [ ] **Step 4: Run the focused integration test to verify it passes**

Run: `npx vitest run tests/session/SessionManager.test.ts -t "custom rendered markdown reply for /status"`

Expected: PASS with the card payload containing the section headings and the fallback reply remaining readable.

- [ ] **Step 5: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: render status replies with markdown layout"
```

### Task 3: Run full verification for status paths

**Files:**
- Modify: `tests/session/SessionManager.test.ts` if final assertions need refinement

- [ ] **Step 1: Add or refine final assertions for empty-field omission and raw-block default rendering**

```ts
it('omits empty optional local fields and still shows the raw block by default', async () => {
  // Extend the existing /status test with assertions for omitted Summary/Pending approvals
  // and the presence of the Raw section when rawText exists.
});
```

- [ ] **Step 2: Run the status formatter and session test suite**

Run: `npx vitest run tests/status/CodexStatusFormatter.test.ts tests/status/StatusMessageFormatter.test.ts tests/session/SessionManager.test.ts`

Expected: PASS with `/status` rendering and existing status behavior still green.

- [ ] **Step 3: Run the build**

Run: `npm run build`

Expected: PASS with TypeScript compilation succeeding.

- [ ] **Step 4: Commit any final test-only refinements**

```bash
git add tests/status/StatusMessageFormatter.test.ts tests/session/SessionManager.test.ts
git commit -m "test: verify status markdown layout"
```

## Self-Review

Spec coverage check:

- Dedicated formatter: covered by Task 1.
- `## Session / ## Codex / ## Raw` layout: covered by Task 1 and Task 2.
- Empty-field omission rules: covered by Task 1 and Task 3.
- Raw block shown by default: covered by Task 1 and Task 3.
- Plain-text fallback preserved: covered by Task 1 and Task 2.
- Explicit rendered reply from `/status`: covered by Task 2.
- No changes to fetch/cache/parser behavior: preserved by Task 2 scope and verified in Task 3.

Placeholder scan:

- No `TBD`, `TODO`, or vague implementation steps remain.
- Every code-changing task includes concrete code or test examples.
- Every verification step includes an exact command and expected result.

Type consistency check:

- `formatStatusMessage` is the formatter entry point used consistently in tests and `SessionManager`.
- `codexStatusResult` is referenced as the internal `/status` data source and should match the existing Codex status result shape.
- `bodyMarkdown` and `fallbackText` remain aligned with `renderFeishuMessage` expectations.
