# Codex Status in `/status` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `/status` so it keeps the current local session summary and appends Codex native `status` details with live fetch, cache, and fallback behavior.

**Architecture:** Add a small Codex status subsystem instead of pushing more logic into `SessionManager`. The new subsystem should parse native `status` text into stable fields, fetch live status from a running session with timeout and in-flight deduplication, persist the latest result on the session record, and expose a formatted section that `SessionManager` can append to the existing `/status` reply.

**Tech Stack:** TypeScript, Vitest, existing `SessionManager`, `FileStateStore`, `CodexRunner`, `CodexObservationStore`

---

## File Structure

- Modify: `src/domain/types.ts`
  Add the persisted `CachedCodexStatus` shape and attach it to `SessionRecord`.
- Create: `src/status/CodexStatusParser.ts`
  Parse cleaned native `status` text into a stable summary object.
- Create: `src/status/CodexStatusFormatter.ts`
  Render the structured Codex status block and raw appendix for `/status`.
- Create: `src/status/CodexStatusService.ts`
  Coordinate live fetch, timeout, in-flight dedupe, cache fallback, and observation fallback.
- Modify: `src/session/SessionManager.ts`
  Replace the current plain `/status` assembly with local block + Codex status block orchestration.
- Modify: `tests/helpers/fakes.ts`
  Add fake hooks needed to simulate live `status` fetch resolution and failures.
- Create: `tests/status/CodexStatusParser.test.ts`
  Lock down parsing behavior against representative native `status` text.
- Create: `tests/status/CodexStatusFormatter.test.ts`
  Verify rendering for live, cached, unavailable, and raw appendix cases.
- Create: `tests/status/CodexStatusService.test.ts`
  Verify timeout, dedupe, cache fallback, and observation fallback behavior.
- Modify: `tests/session/SessionManager.test.ts`
  Cover `/status` integration for running, ended, unavailable, and concurrent paths.
- Modify: `README.md`
  Update `/status` documentation to mention Codex-native details and fallback behavior.

### Task 1: Add persisted Codex status type and parser

**Files:**
- Modify: `src/domain/types.ts`
- Create: `src/status/CodexStatusParser.ts`
- Test: `tests/status/CodexStatusParser.test.ts`

- [ ] **Step 1: Write the failing parser tests**

```ts
import { describe, expect, it } from 'vitest';
import { parseCodexStatusText } from '../../src/status/CodexStatusParser.js';

describe('parseCodexStatusText', () => {
  it('extracts stable labeled fields from native status text', () => {
    const parsed = parseCodexStatusText(`
Status: running
Task: Implement status integration
Progress: waiting for tests
Context window: 61% used
Tokens: 12345 input, 678 output
Model: gpt-5-codex
CWD: /repo
    `);

    expect(parsed).toEqual({
      statusLine: 'running',
      currentTask: 'Implement status integration',
      progressHint: 'waiting for tests',
      contextWindow: '61% used',
      tokenUsage: '12345 input, 678 output',
      model: 'gpt-5-codex',
      cwd: '/repo',
    });
  });

  it('keeps partial results when only some fields are recognized', () => {
    const parsed = parseCodexStatusText(`
Status: idle
Model: gpt-5-codex
Unrecognized: keep in raw text only
    `);

    expect(parsed).toEqual({
      statusLine: 'idle',
      model: 'gpt-5-codex',
    });
  });

  it('returns an empty summary when no known fields are found', () => {
    expect(parseCodexStatusText('plain text without labels')).toEqual({});
  });
});
```

- [ ] **Step 2: Run the parser test to verify it fails**

Run: `pnpm vitest run tests/status/CodexStatusParser.test.ts`

Expected: FAIL with module-not-found or export-not-found errors for `CodexStatusParser`.

- [ ] **Step 3: Add the persisted type to the domain model**

```ts
export interface CachedCodexStatusSummary {
  statusLine?: string;
  currentTask?: string;
  progressHint?: string;
  contextWindow?: string;
  tokenUsage?: string;
  model?: string;
  cwd?: string;
}

export interface CachedCodexStatus {
  source: 'live' | 'cached' | 'observation_fallback';
  fetchedAt: string;
  rawText: string;
  summary: CachedCodexStatusSummary;
}

export interface SessionRecord {
  id: string;
  chatId: string;
  projectId: string;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  logPath: string;
  exitCode?: number;
  lastSummary?: string;
  stopRequested?: boolean;
  codexSessionId?: string;
  resumedFromSessionId?: string;
  resumeSource?: 'code_bot' | 'codex';
  codexStatus?: CachedCodexStatus;
}
```

- [ ] **Step 4: Implement the parser**

```ts
import type { CachedCodexStatusSummary } from '../domain/types.js';

const FIELD_PATTERNS: Array<[keyof CachedCodexStatusSummary, RegExp]> = [
  ['statusLine', /^status:\s*(.+)$/i],
  ['currentTask', /^(task|current task):\s*(.+)$/i],
  ['progressHint', /^(progress|progress hint):\s*(.+)$/i],
  ['contextWindow', /^context window:\s*(.+)$/i],
  ['tokenUsage', /^(tokens|token usage):\s*(.+)$/i],
  ['model', /^model:\s*(.+)$/i],
  ['cwd', /^(cwd|working directory):\s*(.+)$/i],
];

export function parseCodexStatusText(text: string): CachedCodexStatusSummary {
  const summary: CachedCodexStatusSummary = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    for (const [key, pattern] of FIELD_PATTERNS) {
      const match = line.match(pattern);
      if (!match) {
        continue;
      }
      summary[key] = match.at(-1)?.trim();
      break;
    }
  }

  return summary;
}
```

- [ ] **Step 5: Run the parser test to verify it passes**

Run: `pnpm vitest run tests/status/CodexStatusParser.test.ts`

Expected: PASS with 3 tests passed.

- [ ] **Step 6: Commit**

```bash
git add src/domain/types.ts src/status/CodexStatusParser.ts tests/status/CodexStatusParser.test.ts
git commit -m "feat: add codex status parser and cache types"
```

### Task 2: Add formatter coverage for `/status` Codex sections

**Files:**
- Create: `src/status/CodexStatusFormatter.ts`
- Test: `tests/status/CodexStatusFormatter.test.ts`

- [ ] **Step 1: Write the failing formatter tests**

```ts
import { describe, expect, it } from 'vitest';
import { formatCodexStatusSection } from '../../src/status/CodexStatusFormatter.js';

describe('formatCodexStatusSection', () => {
  it('renders structured summary fields and the raw appendix', () => {
    const reply = formatCodexStatusSection({
      kind: 'available',
      status: {
        source: 'live',
        fetchedAt: '2026-06-03T08:00:00.000Z',
        rawText: 'Status: running\nTask: Implement status integration',
        summary: {
          statusLine: 'running',
          currentTask: 'Implement status integration',
        },
      },
    });

    expect(reply).toContain('Codex status');
    expect(reply).toContain('Source: live');
    expect(reply).toContain('Status line: running');
    expect(reply).toContain('Current task: Implement status integration');
    expect(reply).toContain('Codex raw status:');
  });

  it('renders unavailable when nothing can be shown', () => {
    expect(formatCodexStatusSection({ kind: 'unavailable' })).toContain('Codex status: unavailable');
  });
});
```

- [ ] **Step 2: Run the formatter test to verify it fails**

Run: `pnpm vitest run tests/status/CodexStatusFormatter.test.ts`

Expected: FAIL with module-not-found or export-not-found errors for `CodexStatusFormatter`.

- [ ] **Step 3: Implement the formatter**

```ts
import type { CachedCodexStatus } from '../domain/types.js';

export type CodexStatusSection =
  | { kind: 'available'; status: CachedCodexStatus }
  | { kind: 'unavailable' };

export function formatCodexStatusSection(section: CodexStatusSection): string {
  if (section.kind === 'unavailable') {
    return 'Codex status: unavailable';
  }

  const { status } = section;
  const lines = ['Codex status', `Source: ${status.source}`, `Fetched at: ${status.fetchedAt}`];

  if (status.summary.statusLine) {
    lines.push(`Status line: ${status.summary.statusLine}`);
  }
  if (status.summary.currentTask) {
    lines.push(`Current task: ${status.summary.currentTask}`);
  }
  if (status.summary.progressHint) {
    lines.push(`Progress hint: ${status.summary.progressHint}`);
  }
  if (status.summary.contextWindow) {
    lines.push(`Context window: ${status.summary.contextWindow}`);
  }
  if (status.summary.tokenUsage) {
    lines.push(`Token usage: ${status.summary.tokenUsage}`);
  }
  if (status.summary.model) {
    lines.push(`Model: ${status.summary.model}`);
  }
  if (status.summary.cwd) {
    lines.push(`Working directory: ${status.summary.cwd}`);
  }
  if (status.rawText) {
    lines.push('', 'Codex raw status:', status.rawText);
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the formatter test to verify it passes**

Run: `pnpm vitest run tests/status/CodexStatusFormatter.test.ts`

Expected: PASS with 2 tests passed.

- [ ] **Step 5: Commit**

```bash
git add src/status/CodexStatusFormatter.ts tests/status/CodexStatusFormatter.test.ts
git commit -m "feat: format codex status sections"
```

### Task 3: Add live fetch, timeout, cache fallback, and observation fallback service

**Files:**
- Create: `src/status/CodexStatusService.ts`
- Modify: `tests/helpers/fakes.ts`
- Test: `tests/status/CodexStatusService.test.ts`

- [ ] **Step 1: Write the failing service tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { FakeCodexObservationStore, FakeCodexRunner } from '../helpers/fakes.js';
import { createCodexStatusService } from '../../src/status/CodexStatusService.js';

describe('createCodexStatusService', () => {
  it('reuses one in-flight live fetch per session', async () => {
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const service = createCodexStatusService({
      runner,
      observationStore,
      now: () => new Date('2026-06-03T08:00:00.000Z'),
      timeoutMs: 100,
    });

    const first = service.fetchForRunningSession({
      sessionId: 'sess_1',
      codexSessionId: 'codex_1',
      cached: undefined,
    });
    const second = service.fetchForRunningSession({
      sessionId: 'sess_1',
      codexSessionId: 'codex_1',
      cached: undefined,
    });

    runner.resolveStatusRequest('sess_1', 'Status: running\nTask: Implement status integration');
    const [a, b] = await Promise.all([first, second]);

    expect(a.kind).toBe('available');
    expect(b).toEqual(a);
    expect(runner.sentMessages).toEqual(['status']);
  });

  it('falls back to cached status after timeout', async () => {
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    const service = createCodexStatusService({
      runner,
      observationStore,
      now: () => new Date('2026-06-03T08:00:00.000Z'),
      timeoutMs: 1,
    });

    const result = await service.fetchForRunningSession({
      sessionId: 'sess_1',
      codexSessionId: 'codex_1',
      cached: {
        source: 'cached',
        fetchedAt: '2026-06-03T07:59:00.000Z',
        rawText: 'Status: running',
        summary: { statusLine: 'running' },
      },
    });

    expect(result).toEqual({
      kind: 'available',
      status: {
        source: 'cached',
        fetchedAt: '2026-06-03T07:59:00.000Z',
        rawText: 'Status: running',
        summary: { statusLine: 'running' },
      },
    });
  });

  it('uses observation fallback when live and cache are unavailable', async () => {
    const runner = new FakeCodexRunner();
    const observationStore = new FakeCodexObservationStore();
    observationStore.snapshots.set('codex_1', {
      availability: { kind: 'ready' },
      codexSessionId: 'codex_1',
      status: 'running',
      latestActivityAt: '2026-06-03T08:00:00.000Z',
      latestCommentary: 'Implementing tests',
      recentToolEvents: [],
    });

    const service = createCodexStatusService({
      runner,
      observationStore,
      now: () => new Date('2026-06-03T08:00:00.000Z'),
      timeoutMs: 1,
    });

    const result = await service.fetchForRunningSession({
      sessionId: 'sess_1',
      codexSessionId: 'codex_1',
      cached: undefined,
    });

    expect(result.kind).toBe('available');
    if (result.kind === 'available') {
      expect(result.status.source).toBe('observation_fallback');
      expect(result.status.summary.statusLine).toBe('running');
      expect(result.status.summary.progressHint).toBe('Implementing tests');
    }
  });
});
```

- [ ] **Step 2: Run the service test to verify it fails**

Run: `pnpm vitest run tests/status/CodexStatusService.test.ts`

Expected: FAIL because the new service module and fake runner helpers do not exist yet.

- [ ] **Step 3: Extend the fake runner so tests can resolve a live `status` request**

```ts
export class FakeCodexRunner implements CodexRunner {
  readonly sentMessages: string[] = [];
  readonly starts: CodexRunOptions[] = [];
  private readonly pendingStatusRequests = new Map<string, (text: string) => void>();

  async send(sessionId: string, text: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Unknown fake session: ${sessionId}`);
    }
    this.sentMessages.push(text);
  }

  waitForStatusRequest(sessionId: string): Promise<string> {
    return new Promise((resolve) => {
      this.pendingStatusRequests.set(sessionId, resolve);
    });
  }

  resolveStatusRequest(sessionId: string, text: string): void {
    const resolve = this.pendingStatusRequests.get(sessionId);
    if (!resolve) {
      throw new Error(`No pending fake status request for ${sessionId}`);
    }
    this.pendingStatusRequests.delete(sessionId);
    resolve(text);
  }
}
```

- [ ] **Step 4: Implement the service with timeout and dedupe**

```ts
import type { CachedCodexStatus } from '../domain/types.js';
import type { CodexRunner } from '../codex/CodexRunner.js';
import type { CodexObservationStore } from '../observations/CodexObservationStore.js';
import { parseCodexStatusText } from './CodexStatusParser.js';

type AvailableResult = { kind: 'available'; status: CachedCodexStatus };
type UnavailableResult = { kind: 'unavailable' };
export type CodexStatusLookupResult = AvailableResult | UnavailableResult;

export function createCodexStatusService(deps: {
  runner: CodexRunner;
  observationStore: CodexObservationStore;
  now?: () => Date;
  timeoutMs?: number;
}) {
  const inFlight = new Map<string, Promise<CodexStatusLookupResult>>();
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 2000;

  async function fetchForRunningSession(input: {
    sessionId: string;
    codexSessionId?: string;
    cached?: CachedCodexStatus;
  }): Promise<CodexStatusLookupResult> {
    const existing = inFlight.get(input.sessionId);
    if (existing) {
      return existing;
    }

    const current = fetchLiveThenFallback(input).finally(() => {
      inFlight.delete(input.sessionId);
    });
    inFlight.set(input.sessionId, current);
    return current;
  }

  async function fetchLiveThenFallback(input: {
    sessionId: string;
    codexSessionId?: string;
    cached?: CachedCodexStatus;
  }): Promise<CodexStatusLookupResult> {
    try {
      await deps.runner.send(input.sessionId, 'status');
      const rawText = await withTimeout(readLiveStatusText(input.sessionId), timeoutMs);
      return {
        kind: 'available',
        status: {
          source: 'live',
          fetchedAt: now().toISOString(),
          rawText,
          summary: parseCodexStatusText(rawText),
        },
      };
    } catch {
      if (input.cached) {
        return { kind: 'available', status: input.cached };
      }
      if (input.codexSessionId) {
        const observation = await deps.observationStore.readSnapshot({ codexSessionId: input.codexSessionId });
        if (observation.availability.kind === 'ready' || observation.availability.kind === 'stale') {
          return {
            kind: 'available',
            status: {
              source: 'observation_fallback',
              fetchedAt: now().toISOString(),
              rawText: [observation.latestCommentary].filter(Boolean).join('\n'),
              summary: {
                statusLine: observation.status,
                progressHint: observation.latestCommentary,
              },
            },
          };
        }
      }
      return { kind: 'unavailable' };
    }
  }

  return { fetchForRunningSession };
}
```

- [ ] **Step 5: Run the service test to verify it passes**

Run: `pnpm vitest run tests/status/CodexStatusService.test.ts`

Expected: PASS with live, timeout, and observation fallback coverage.

- [ ] **Step 6: Commit**

```bash
git add src/status/CodexStatusService.ts tests/helpers/fakes.ts tests/status/CodexStatusService.test.ts
git commit -m "feat: add codex status live fetch service"
```

### Task 4: Integrate `/status` with session cache, live fetch, and rendering

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing `/status` integration tests**

```ts
it('includes live Codex status in /status for a running session', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  runner.resolveStatusRequest(sessionId, 'Status: running\nTask: Implement status integration\nModel: gpt-5-codex');

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });

  expect(result.reply).toContain('Project: repo');
  expect(result.reply).toContain('Codex status');
  expect(result.reply).toContain('Source: live');
  expect(result.reply).toContain('Current task: Implement status integration');
  await expect(store.getSession(sessionId)).resolves.toMatchObject({
    codexStatus: {
      source: 'live',
      summary: { currentTask: 'Implement status integration' },
    },
  });
});

it('uses cached Codex status for an exited session without sending a new request', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  const session = (await store.getSession(sessionId))!;
  await store.saveSession({
    ...session,
    status: 'exited',
    codexStatus: {
      source: 'cached',
      fetchedAt: '2026-06-03T08:00:00.000Z',
      rawText: 'Status: completed',
      summary: { statusLine: 'completed' },
    },
  });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/status' });

  expect(result.reply).toContain('Source: cached');
  expect(runner.sentMessages).not.toContain('status');
});
```

- [ ] **Step 2: Run the integration tests to verify they fail**

Run: `pnpm vitest run tests/session/SessionManager.test.ts -t "/status"`

Expected: FAIL because `/status` still returns only the local block and does not persist `codexStatus`.

- [ ] **Step 3: Inject the new service into `SessionManager` and append the rendered Codex section**

```ts
private async status(chatId: string): Promise<BotTextResult> {
  const chat = await this.store.getChat(chatId);
  const session = chat?.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
  const pendingApprovals = await this.store.listPendingApprovalsByChat(chatId);

  const localLines = [
    `Project: ${chat?.currentProjectId ?? 'none'}`,
    `Session: ${chat?.currentSessionId ?? 'none'}`,
    `Status: ${session?.status ?? 'none'}`,
    `Summary: ${session?.lastSummary ?? 'none'}`,
    `Pending approvals: ${pendingApprovals.length > 0 ? pendingApprovals.map((approval) => approval.id).join(', ') : 'none'}`,
  ];

  const codexSection = await this.lookupCodexStatusSection(session);
  return {
    reply: [...localLines, '', codexSection].join('\n'),
  };
}

private async lookupCodexStatusSection(session: SessionRecord | undefined): Promise<string> {
  if (!session) {
    return 'Codex status: unavailable';
  }

  if (session.status === 'running' || session.status === 'starting') {
    const result = await this.codexStatusService.fetchForRunningSession({
      sessionId: session.id,
      codexSessionId: session.codexSessionId,
      cached: session.codexStatus,
    });
    if (result.kind === 'available') {
      await this.store.updateSession(session.id, (current) => ({
        ...current,
        codexStatus: result.status.source === 'live' ? result.status : current.codexStatus ?? result.status,
        updatedAt: new Date().toISOString(),
      }));
      return formatCodexStatusSection(result);
    }
    return formatCodexStatusSection(result);
  }

  if (session.codexStatus) {
    return formatCodexStatusSection({
      kind: 'available',
      status: { ...session.codexStatus, source: 'cached' },
    });
  }

  return formatCodexStatusSection({ kind: 'unavailable' });
}
```

- [ ] **Step 4: Run the focused integration tests to verify they pass**

Run: `pnpm vitest run tests/session/SessionManager.test.ts -t "/status"`

Expected: PASS for the new live and cached cases, while keeping existing `/status` behavior green.

- [ ] **Step 5: Run the broader status-related suite**

Run: `pnpm vitest run tests/status/CodexStatusParser.test.ts tests/status/CodexStatusFormatter.test.ts tests/status/CodexStatusService.test.ts tests/session/SessionManager.test.ts`

Expected: PASS with all new and existing status-path tests green.

- [ ] **Step 6: Commit**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat: include codex native status in status command"
```

### Task 5: Update user-facing docs

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the failing documentation expectation as a diff checklist**

```md
- `/status` now includes:
  - local bot/session summary
  - live Codex native status when the session is running
  - cached or unavailable Codex state when live status cannot be fetched
```

- [ ] **Step 2: Update the README command section**

```md
/status

Shows the current project and session plus a Codex-native status block.
When the current session is running, the bot asks Codex for a fresh `status`.
When live status is unavailable, the bot falls back to the most recent cached Codex status or marks it unavailable.
```

- [ ] **Step 3: Run a quick doc sanity check**

Run: `rg -n "/status|Codex-native status|cached Codex status" README.md`

Expected: output shows the refreshed `/status` description in the command section.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: document codex status in status command"
```

## Self-Review

Spec coverage check:

- Mixed strategy: covered by Task 3 and Task 4.
- Session cache model: covered by Task 1 and Task 4.
- Structured summary + raw appendix: covered by Task 1 and Task 2.
- Running-session live fetch only: covered by Task 3 and Task 4.
- Ended-session cached-only behavior: covered by Task 4.
- Timeout and concurrency: covered by Task 3.
- Observation fallback: covered by Task 3.
- `/status` rendering and persistence: covered by Task 2 and Task 4.
- Documentation update: covered by Task 5.

Placeholder scan:

- No `TBD`, `TODO`, or “implement later” placeholders remain.
- Every code-changing task includes concrete code snippets.
- Every test task includes an exact command and expected outcome.

Type consistency check:

- `CachedCodexStatus` and `CachedCodexStatusSummary` are introduced once in `src/domain/types.ts` and reused consistently in parser, formatter, service, and `SessionManager`.
- `formatCodexStatusSection` consumes the same `CachedCodexStatus` shape the service returns.
- `fetchForRunningSession` is the single service entry point used by `SessionManager`.
