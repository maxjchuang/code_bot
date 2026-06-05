# Current TUI Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `/current`, a Feishu card command that shows a bounded, styled snapshot of the current Codex TUI screen using `@xterm/headless`.

**Architecture:** Add a terminal snapshot layer under `src/output/` that wraps `@xterm/headless`, a live observer owned by `SessionManager`, and a Feishu card renderer under `src/feishu/`. `/current` reads live screen state first, falls back to bounded raw-log replay, and finally falls back to the existing sanitizer/plain text path. Existing `/tail` and `/rawtail` behavior remains compatible.

**Tech Stack:** TypeScript, Vitest, Node.js 20+, `@xterm/headless`, existing `FileStateStore`, `SessionManager`, and Feishu rendered-message path.

---

## File Map

- Modify `package.json`, `package-lock.json`: add `@xterm/headless`.
- Modify `src/domain/types.ts`: add `TerminalSnapshotConfig` and extend `BotConfig.output`.
- Modify `src/config/loadConfig.ts`: default and validate `output.terminalSnapshot`.
- Modify `config.example.json`: document `output.terminalSnapshot`.
- Modify `src/codex/CodexRunner.ts`: accept configurable PTY `cols` and `rows`.
- Create `src/output/TerminalScreenBuffer.ts`: local wrapper around `@xterm/headless` and snapshot extraction.
- Create `tests/output/TerminalScreenBuffer.test.ts`: screen-buffer unit tests.
- Create `src/output/CodexTerminalObserver.ts`: session-id keyed live terminal buffers plus bounded replay.
- Create `tests/output/CodexTerminalObserver.test.ts`: observer unit tests.
- Create `src/feishu/CurrentScreenCard.ts`: render terminal snapshots as Feishu cards plus plain-text fallback.
- Create `tests/feishu/CurrentScreenCard.test.ts`: card renderer tests.
- Modify `src/commands/CommandRouter.ts`: add `current` to command names.
- Modify `tests/commands/CommandRouter.test.ts`: parser coverage for `/current`.
- Modify `src/state/FileStateStore.ts`: add bounded raw session-log byte tail for replay.
- Modify `tests/state/FileStateStore.test.ts`: byte-tail coverage.
- Modify `src/session/SessionManager.ts`: wire observer, write PTY chunks, implement `/current`, update help.
- Modify `tests/session/SessionManager.test.ts`: command behavior coverage.
- Modify `README.md`: document `/current`.

## Task 1: Add Dependency and Snapshot Config

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/domain/types.ts`
- Modify: `src/config/loadConfig.ts`
- Modify: `tests/config/loadConfig.test.ts`
- Modify: `config.example.json`

- [ ] **Step 1: Install `@xterm/headless`**

Run:

```bash
npm install @xterm/headless
```

Expected: `package.json` and `package-lock.json` include `@xterm/headless`.

- [ ] **Step 2: Add failing config tests**

Append these tests to `tests/config/loadConfig.test.ts`:

```ts
it('defaults terminal snapshot config when omitted', async () => {
  const root = await createTmpDir();
  await writeConfig(root, validConfig());

  await expect(loadConfig(root)).resolves.toMatchObject({
    output: {
      terminalSnapshot: {
        cols: 120,
        rows: 40,
        scrollback: 200,
        replayMaxBytes: 262144,
        cardMaxRows: 40,
        cardMaxLineChars: 160,
        maxStyledSegmentsPerLine: 8,
      },
    },
  });
});

it('loads terminal snapshot config overrides', async () => {
  const root = await createTmpDir();
  await writeConfig(
    root,
    validConfig({
      output: {
        directMaxChars: 1800,
        chunkSize: 1500,
        terminalSnapshot: {
          cols: 100,
          rows: 30,
          scrollback: 50,
          replayMaxBytes: 4096,
          cardMaxRows: 20,
          cardMaxLineChars: 80,
          maxStyledSegmentsPerLine: 4,
        },
      },
    }),
  );

  await expect(loadConfig(root)).resolves.toMatchObject({
    output: {
      terminalSnapshot: {
        cols: 100,
        rows: 30,
        scrollback: 50,
        replayMaxBytes: 4096,
        cardMaxRows: 20,
        cardMaxLineChars: 80,
        maxStyledSegmentsPerLine: 4,
      },
    },
  });
});

it('rejects invalid terminal snapshot config values', async () => {
  const root = await createTmpDir();
  await writeConfig(
    root,
    validConfig({
      output: {
        directMaxChars: 1800,
        chunkSize: 1500,
        terminalSnapshot: { cols: 0 },
      },
    }),
  );

  await expect(loadConfig(root)).rejects.toThrow('Invalid config field: output.terminalSnapshot.cols');
});
```

- [ ] **Step 3: Run config tests and verify they fail**

Run:

```bash
npm test -- tests/config/loadConfig.test.ts
```

Expected: FAIL because `terminalSnapshot` is not part of `BotConfig.output`.

- [ ] **Step 4: Add config types**

In `src/domain/types.ts`, add this interface above `BotConfig`:

```ts
export interface TerminalSnapshotConfig {
  cols: number;
  rows: number;
  scrollback: number;
  replayMaxBytes: number;
  cardMaxRows: number;
  cardMaxLineChars: number;
  maxStyledSegmentsPerLine: number;
}
```

Change `BotConfig.output` to:

```ts
  output: {
    directMaxChars: number;
    chunkSize: number;
    terminalSnapshot: TerminalSnapshotConfig;
  };
```

- [ ] **Step 5: Load defaults and overrides**

In `src/config/loadConfig.ts`, add this helper near `normalizeUpgrade`:

```ts
function normalizeTerminalSnapshot(value: unknown): BotConfig['output']['terminalSnapshot'] {
  const record = optionalRecord(value, 'output.terminalSnapshot');
  return {
    cols: optionalPositiveNumber(record.cols, 120, 'output.terminalSnapshot.cols'),
    rows: optionalPositiveNumber(record.rows, 40, 'output.terminalSnapshot.rows'),
    scrollback: optionalPositiveNumber(record.scrollback, 200, 'output.terminalSnapshot.scrollback'),
    replayMaxBytes: optionalPositiveNumber(record.replayMaxBytes, 262144, 'output.terminalSnapshot.replayMaxBytes'),
    cardMaxRows: optionalPositiveNumber(record.cardMaxRows, 40, 'output.terminalSnapshot.cardMaxRows'),
    cardMaxLineChars: optionalPositiveNumber(record.cardMaxLineChars, 160, 'output.terminalSnapshot.cardMaxLineChars'),
    maxStyledSegmentsPerLine: optionalPositiveNumber(
      record.maxStyledSegmentsPerLine,
      8,
      'output.terminalSnapshot.maxStyledSegmentsPerLine',
    ),
  };
}
```

Then change the returned `output` object:

```ts
    output: {
      directMaxChars: requirePositiveNumber(output.directMaxChars, 'output.directMaxChars'),
      chunkSize: requirePositiveNumber(output.chunkSize, 'output.chunkSize'),
      terminalSnapshot: normalizeTerminalSnapshot(output.terminalSnapshot),
    },
```

- [ ] **Step 6: Update example config**

In `config.example.json`, update `output`:

```json
  "output": {
    "directMaxChars": 1800,
    "chunkSize": 1500,
    "terminalSnapshot": {
      "cols": 120,
      "rows": 40,
      "scrollback": 200,
      "replayMaxBytes": 262144,
      "cardMaxRows": 40,
      "cardMaxLineChars": 160,
      "maxStyledSegmentsPerLine": 8
    }
  },
```

- [ ] **Step 7: Run tests**

Run:

```bash
npm test -- tests/config/loadConfig.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/domain/types.ts src/config/loadConfig.ts tests/config/loadConfig.test.ts config.example.json
git commit -m "feat(config): add terminal snapshot settings"
```

## Task 2: Make PTY Size Configurable

**Files:**
- Modify: `src/codex/CodexRunner.ts`
- Modify: `tests/codex/CodexRunner.test.ts`
- Modify: `src/app/createApp.ts` if the runner is constructed there

- [ ] **Step 1: Add failing runner test**

In `tests/codex/CodexRunner.test.ts`, add:

```ts
it('uses configured terminal dimensions when spawning Codex', async () => {
  const spawn = vi.fn().mockReturnValue(fakePty());
  const runner = new PtyCodexRunner(
    { command: 'codex', defaultArgs: [], terminal: { cols: 100, rows: 30 } },
    { spawn },
  );

  await runner.start({
    sessionId: 'sess_1',
    cwd: '/repo',
    args: [],
    onOutput: vi.fn(),
    onExit: vi.fn(),
  });

  expect(spawn).toHaveBeenCalledWith(
    'codex',
    expect.any(Array),
    expect.objectContaining({ cols: 100, rows: 30 }),
  );
});
```

If `fakePty()` is local to the test file, reuse it. If not, create the same minimal fake used by existing `PtyCodexRunner` tests:

```ts
function fakePty() {
  return {
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    kill: vi.fn(),
  };
}
```

- [ ] **Step 2: Run runner test and verify it fails**

```bash
npm test -- tests/codex/CodexRunner.test.ts
```

Expected: FAIL because the constructor config does not accept `terminal`.

- [ ] **Step 3: Implement configurable dimensions**

In `src/codex/CodexRunner.ts`, change the constructor config type:

```ts
  constructor(
    private readonly config: {
      command: string;
      defaultArgs: string[];
      terminal?: { cols: number; rows: number };
    },
    private readonly ptyModule: Pick<typeof pty, 'spawn'> = pty,
  ) {}
```

Change spawn options:

```ts
    const term = this.ptyModule.spawn(this.config.command, args, {
      name: 'xterm-256color',
      cols: this.config.terminal?.cols ?? 120,
      rows: this.config.terminal?.rows ?? 40,
      cwd: options.cwd,
      env: process.env,
    });
```

Find the production `new PtyCodexRunner(...)` call in `src/app/createApp.ts` or `src/index.ts` and pass:

```ts
terminal: {
  cols: config.output.terminalSnapshot.cols,
  rows: config.output.terminalSnapshot.rows,
},
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/codex/CodexRunner.test.ts tests/app/createApp.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/codex/CodexRunner.ts tests/codex/CodexRunner.test.ts src/app/createApp.ts
git commit -m "feat(codex): use configured terminal dimensions"
```

## Task 3: Build `TerminalScreenBuffer`

**Files:**
- Create: `src/output/TerminalScreenBuffer.ts`
- Create: `tests/output/TerminalScreenBuffer.test.ts`

- [ ] **Step 1: Write failing screen-buffer tests**

Create `tests/output/TerminalScreenBuffer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { TerminalScreenBuffer, replayTerminalSnapshot } from '../../src/output/TerminalScreenBuffer.js';

const config = {
  cols: 40,
  rows: 6,
  scrollback: 20,
  replayMaxBytes: 4096,
  cardMaxRows: 6,
  cardMaxLineChars: 80,
  maxStyledSegmentsPerLine: 8,
};

describe('TerminalScreenBuffer', () => {
  it('renders cursor movement and erase-line sequences into the final viewport', () => {
    const buffer = new TerminalScreenBuffer(config);

    buffer.write('old status');
    buffer.write('\r\u001b[Knew status\n');
    buffer.write('second line');

    expect(buffer.snapshot().rows.map((row) => row.text).filter(Boolean)).toEqual(['new status', 'second line']);
  });

  it('preserves Codex-like TUI layout text', () => {
    const buffer = new TerminalScreenBuffer(config);

    buffer.write('╭────────────╮\n');
    buffer.write('│ >_ Codex   │\n');
    buffer.write('╰────────────╯\n');
    buffer.write('⚠ MCP startup incomplete\n');
    buffer.write('› 只读查看当前目录\n');

    expect(buffer.snapshot().rows.map((row) => row.text).join('\n')).toContain('› 只读查看当前目录');
  });

  it('extracts bounded style spans for common ANSI colors and bold text', () => {
    const buffer = new TerminalScreenBuffer(config);

    buffer.write('\u001b[1mBold\u001b[0m \u001b[31mError\u001b[0m \u001b[33mWarn\u001b[0m');

    const rows = buffer.snapshot().rows.filter((row) => row.text.trim() !== '');
    expect(rows[0]?.text).toContain('Bold Error Warn');
    expect(rows[0]?.spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'Bold', bold: true }),
        expect.objectContaining({ text: 'Error', color: 'red' }),
        expect.objectContaining({ text: 'Warn', color: 'yellow' }),
      ]),
    );
  });

  it('replays only the newest bounded bytes', () => {
    const snapshot = replayTerminalSnapshot(['old line\n', 'x'.repeat(5000), '\nnew line\n'], {
      ...config,
      replayMaxBytes: 64,
    });

    const text = snapshot.rows.map((row) => row.text).join('\n');
    expect(text).toContain('new line');
    expect(text).not.toContain('old line');
    expect(snapshot.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run screen-buffer tests and verify they fail**

```bash
npm test -- tests/output/TerminalScreenBuffer.test.ts
```

Expected: FAIL because `TerminalScreenBuffer.ts` does not exist.

- [ ] **Step 3: Implement `TerminalScreenBuffer`**

Create `src/output/TerminalScreenBuffer.ts`:

```ts
import { Terminal } from '@xterm/headless';
import type { TerminalSnapshotConfig } from '../domain/types.js';

export type TerminalStyleColor = 'red' | 'green' | 'yellow' | 'gray';

export interface TerminalSnapshotSpan {
  text: string;
  bold?: boolean;
  dim?: boolean;
  color?: TerminalStyleColor;
}

export interface TerminalSnapshotRow {
  text: string;
  spans: TerminalSnapshotSpan[];
}

export interface TerminalSnapshot {
  cols: number;
  rows: TerminalSnapshotRow[];
  capturedAt: string;
  source: 'live' | 'replay' | 'fallback';
  truncated: boolean;
  notes: string[];
}

export class TerminalScreenBuffer {
  private terminal: Terminal;

  constructor(private readonly config: TerminalSnapshotConfig) {
    this.terminal = this.createTerminal();
  }

  write(chunk: string): void {
    this.terminal.write(chunk);
  }

  snapshot(source: TerminalSnapshot['source'] = 'live', notes: string[] = []): TerminalSnapshot {
    const buffer = this.terminal.buffer.active;
    const rows: TerminalSnapshotRow[] = [];
    for (let index = 0; index < this.config.rows; index += 1) {
      const line = buffer.getLine(index);
      if (!line) {
        rows.push({ text: '', spans: [] });
        continue;
      }
      rows.push(snapshotLine(line, this.config.cols));
    }
    return {
      cols: this.config.cols,
      rows,
      capturedAt: new Date().toISOString(),
      source,
      truncated: false,
      notes,
    };
  }

  resetAndReplay(input: string | string[]): TerminalSnapshot {
    this.terminal.dispose();
    this.terminal = this.createTerminal();
    const replay = boundReplayInput(input, this.config.replayMaxBytes);
    this.terminal.write(replay.text);
    return {
      ...this.snapshot('replay', replay.truncated ? ['Replayed newest bounded raw terminal log bytes.'] : []),
      truncated: replay.truncated,
    };
  }

  private createTerminal(): Terminal {
    return new Terminal({
      cols: this.config.cols,
      rows: this.config.rows,
      scrollback: this.config.scrollback,
      allowProposedApi: true,
    });
  }
}

export function replayTerminalSnapshot(input: string | string[], config: TerminalSnapshotConfig): TerminalSnapshot {
  return new TerminalScreenBuffer(config).resetAndReplay(input);
}

function boundReplayInput(input: string | string[], maxBytes: number): { text: string; truncated: boolean } {
  const text = Array.isArray(input) ? input.join('') : input;
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) {
    return { text, truncated: false };
  }
  return { text: bytes.subarray(bytes.length - maxBytes).toString('utf8'), truncated: true };
}

function snapshotLine(line: NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>, cols: number): TerminalSnapshotRow {
  const translated = line.translateToString(false);
  const text = translated.length > cols ? translated.slice(0, cols) : translated;
  const spans: TerminalSnapshotSpan[] = [];
  let current: TerminalSnapshotSpan | undefined;

  for (let column = 0; column < Math.min(cols, text.length); column += 1) {
    const cell = line.getCell(column);
    const char = text[column] ?? '';
    if (!cell || char === '') {
      continue;
    }
    const next = styleForCell(cell, char);
    if (current && sameStyle(current, next)) {
      current.text += next.text;
    } else {
      current = next;
      spans.push(current);
    }
  }

  return { text, spans };
}

function styleForCell(cell: NonNullable<ReturnType<NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>['getCell']>>, text: string): TerminalSnapshotSpan {
  const fg = cell.getFgColor();
  const span: TerminalSnapshotSpan = { text };
  if (cell.isBold()) span.bold = true;
  if (cell.isDim()) span.dim = true;
  if (fg === 1 || fg === 9) span.color = 'red';
  if (fg === 2 || fg === 10) span.color = 'green';
  if (fg === 3 || fg === 11) span.color = 'yellow';
  if (cell.isDim()) span.color = span.color ?? 'gray';
  return span;
}

function sameStyle(left: TerminalSnapshotSpan, right: TerminalSnapshotSpan): boolean {
  return left.bold === right.bold && left.dim === right.dim && left.color === right.color;
}
```

If `getFgColor()` does not expose ANSI index values for `@xterm/headless`, adjust `styleForCell` in implementation to use the actual `IBufferCell` API. Keep the public `TerminalSnapshot` interface unchanged.

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/output/TerminalScreenBuffer.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/output/TerminalScreenBuffer.ts tests/output/TerminalScreenBuffer.test.ts
git commit -m "feat(output): add headless terminal screen buffer"
```

## Task 4: Add Live Observer and Raw Byte Replay Source

**Files:**
- Create: `src/output/CodexTerminalObserver.ts`
- Create: `tests/output/CodexTerminalObserver.test.ts`
- Modify: `src/state/FileStateStore.ts`
- Modify: `tests/state/FileStateStore.test.ts`

- [ ] **Step 1: Add failing FileStateStore byte-tail test**

Append to `tests/state/FileStateStore.test.ts`:

```ts
it('tails bounded raw session log bytes for terminal replay', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);

  await store.appendSessionLog('session_bytes', 'old line\n');
  await store.appendSessionLog('session_bytes', 'new line\n');

  await expect(store.tailSessionLogBytes('session_bytes', 9)).resolves.toBe('new line\n');
});

it('returns empty replay bytes when session log is missing', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);

  await expect(store.tailSessionLogBytes('missing', 128)).resolves.toBe('');
});
```

- [ ] **Step 2: Implement `tailSessionLogBytes`**

In `src/state/FileStateStore.ts`, add:

```ts
  async tailSessionLogBytes(sessionId: string, maxBytes: number): Promise<string> {
    const normalizedMaxBytes = Math.floor(maxBytes);
    if (!Number.isFinite(maxBytes) || normalizedMaxBytes <= 0) {
      return '';
    }

    await this.waitForPendingWrites();
    const filePath = this.sessionLogPath(sessionId);
    try {
      const { size } = await stat(filePath);
      const bytesToRead = Math.min(size, normalizedMaxBytes);
      const start = size - bytesToRead;
      const buffer = await readFileWindow(filePath, start, bytesToRead);
      return buffer.toString('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return '';
      }
      throw error;
    }
  }
```

- [ ] **Step 3: Add failing observer tests**

Create `tests/output/CodexTerminalObserver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CodexTerminalObserver } from '../../src/output/CodexTerminalObserver.js';

const config = {
  cols: 40,
  rows: 6,
  scrollback: 20,
  replayMaxBytes: 4096,
  cardMaxRows: 6,
  cardMaxLineChars: 80,
  maxStyledSegmentsPerLine: 8,
};

describe('CodexTerminalObserver', () => {
  it('keeps live snapshots per session', () => {
    const observer = new CodexTerminalObserver(config);

    observer.write('sess_1', 'hello\n');
    observer.write('sess_2', 'other\n');

    expect(observer.snapshot('sess_1')?.rows.map((row) => row.text).join('\n')).toContain('hello');
    expect(observer.snapshot('sess_2')?.rows.map((row) => row.text).join('\n')).toContain('other');
  });

  it('keeps final snapshot after session end and can forget it', () => {
    const observer = new CodexTerminalObserver(config);

    observer.write('sess_1', 'final screen\n');
    observer.end('sess_1');

    expect(observer.snapshot('sess_1')?.rows.map((row) => row.text).join('\n')).toContain('final screen');

    observer.forget('sess_1');
    expect(observer.snapshot('sess_1')).toBeUndefined();
  });
});
```

- [ ] **Step 4: Implement observer**

Create `src/output/CodexTerminalObserver.ts`:

```ts
import type { TerminalSnapshotConfig } from '../domain/types.js';
import { TerminalScreenBuffer, type TerminalSnapshot } from './TerminalScreenBuffer.js';

export class CodexTerminalObserver {
  private readonly buffers = new Map<string, TerminalScreenBuffer>();
  private readonly finalSnapshots = new Map<string, TerminalSnapshot>();

  constructor(private readonly config: TerminalSnapshotConfig) {}

  write(sessionId: string, chunk: string): void {
    const buffer = this.requireBuffer(sessionId);
    buffer.write(chunk);
    this.finalSnapshots.delete(sessionId);
  }

  snapshot(sessionId: string): TerminalSnapshot | undefined {
    const live = this.buffers.get(sessionId);
    if (live) {
      return live.snapshot('live');
    }
    return this.finalSnapshots.get(sessionId);
  }

  end(sessionId: string): void {
    const buffer = this.buffers.get(sessionId);
    if (!buffer) {
      return;
    }
    this.finalSnapshots.set(sessionId, buffer.snapshot('live', ['Session has exited.']));
    this.buffers.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.buffers.delete(sessionId);
    this.finalSnapshots.delete(sessionId);
  }

  private requireBuffer(sessionId: string): TerminalScreenBuffer {
    const existing = this.buffers.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new TerminalScreenBuffer(this.config);
    this.buffers.set(sessionId, created);
    return created;
  }
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- tests/state/FileStateStore.test.ts tests/output/CodexTerminalObserver.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state/FileStateStore.ts tests/state/FileStateStore.test.ts src/output/CodexTerminalObserver.ts tests/output/CodexTerminalObserver.test.ts
git commit -m "feat(output): track live terminal snapshots"
```

## Task 5: Render Current Screen Feishu Cards

**Files:**
- Create: `src/feishu/CurrentScreenCard.ts`
- Create: `tests/feishu/CurrentScreenCard.test.ts`

- [ ] **Step 1: Write failing renderer tests**

Create `tests/feishu/CurrentScreenCard.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderCurrentScreenCard } from '../../src/feishu/CurrentScreenCard.js';
import type { TerminalSnapshot } from '../../src/output/TerminalScreenBuffer.js';

const config = {
  cols: 40,
  rows: 6,
  scrollback: 20,
  replayMaxBytes: 4096,
  cardMaxRows: 6,
  cardMaxLineChars: 20,
  maxStyledSegmentsPerLine: 2,
};

function snapshot(overrides: Partial<TerminalSnapshot> = {}): TerminalSnapshot {
  return {
    cols: 40,
    capturedAt: '2026-06-05T10:00:00.000Z',
    source: 'live',
    truncated: false,
    notes: [],
    rows: [
      { text: '╭──── Codex ────╮', spans: [] },
      { text: '⚠ warning here', spans: [{ text: '⚠ warning here', color: 'yellow' }] },
      { text: '› 只读查看当前目录', spans: [] },
    ],
    ...overrides,
  };
}

describe('renderCurrentScreenCard', () => {
  it('renders a current screen snapshot as a Feishu card with text fallback', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot(),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    expect(rendered.preferred.kind).toBe('card');
    expect(rendered.fallback).toEqual(expect.objectContaining({ kind: 'text' }));
    expect(JSON.stringify(rendered.preferred)).toContain('Codex Current');
    expect(JSON.stringify(rendered.preferred)).toContain('⚠ warning here');
    expect(rendered.fallback.kind === 'text' ? rendered.fallback.text : '').toContain('› 只读查看当前目录');
  });

  it('truncates long rows and records a footer note', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot({ rows: [{ text: 'this line is much longer than the card limit', spans: [] }] }),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    expect(JSON.stringify(rendered.preferred)).toContain('this line is much lo…');
    expect(JSON.stringify(rendered.preferred)).toContain('Rows were truncated');
  });

  it('degrades rows with too many style spans to plain text', () => {
    const rendered = renderCurrentScreenCard({
      snapshot: snapshot({
        rows: [
          {
            text: 'red green yellow',
            spans: [
              { text: 'red', color: 'red' },
              { text: ' green', color: 'green' },
              { text: ' yellow', color: 'yellow' },
            ],
          },
        ],
      }),
      config,
      sessionId: 'sess_1',
      projectId: 'repo',
      status: 'running',
    });

    expect(JSON.stringify(rendered.preferred)).toContain('Some rows were rendered as plain text');
  });
});
```

- [ ] **Step 2: Implement renderer**

Create `src/feishu/CurrentScreenCard.ts`:

```ts
import type { SessionStatus, TerminalSnapshotConfig } from '../domain/types.js';
import type { TerminalSnapshot, TerminalSnapshotRow, TerminalSnapshotSpan } from '../output/TerminalScreenBuffer.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export interface RenderCurrentScreenCardInput {
  snapshot: TerminalSnapshot;
  config: TerminalSnapshotConfig;
  sessionId: string;
  projectId: string;
  status: SessionStatus;
}

export function renderCurrentScreenCard(
  input: RenderCurrentScreenCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const notes = new Set(input.snapshot.notes);
  const rows = trimTrailingBlankRows(input.snapshot.rows).slice(-input.config.cardMaxRows);
  if (rows.length < input.snapshot.rows.length) {
    notes.add('Only the newest visible rows are shown.');
  }

  const bodyRows = rows.map((row) => renderRow(row, input.config, notes));
  const fallbackText = formatFallback(input, rows, notes);
  const payload = {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: 'Codex Current',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `- **Session**: \`${input.sessionId}\``,
            `- **Project**: \`${input.projectId}\``,
            `- **Status**: \`${input.status}\``,
            `- **Source**: \`${input.snapshot.source}\``,
            `- **Captured**: \`${input.snapshot.capturedAt}\``,
          ].join('\n'),
        },
        ...bodyRows,
        ...(notes.size > 0
          ? [
              {
                tag: 'markdown',
                content: Array.from(notes)
                  .map((note) => `_${escapeMarkdown(note)}_`)
                  .join('\n'),
              },
            ]
          : []),
      ],
    },
  };

  return {
    preferred: { kind: 'card', payload },
    fallback: { kind: 'text', text: fallbackText },
  };
}

function renderRow(row: TerminalSnapshotRow, config: TerminalSnapshotConfig, notes: Set<string>): Record<string, unknown> {
  const text = truncateLine(row.text, config.cardMaxLineChars, notes);
  if (row.spans.length === 0 || row.spans.length > config.maxStyledSegmentsPerLine) {
    if (row.spans.length > config.maxStyledSegmentsPerLine) {
      notes.add('Some rows were rendered as plain text because they contain too many style segments.');
    }
    return { tag: 'markdown', content: `\`${escapeInlineCode(text || ' ')}\`` };
  }

  return {
    tag: 'markdown',
    content: row.spans
      .map((span) => formatSpan({ ...span, text: truncateLine(span.text, config.cardMaxLineChars, notes) }))
      .join(''),
  };
}

function formatSpan(span: TerminalSnapshotSpan): string {
  const text = escapeMarkdown(span.text);
  if (span.color === 'red') return `<font color="red">${text}</font>`;
  if (span.color === 'green') return `<font color="green">${text}</font>`;
  if (span.color === 'yellow') return `<font color="orange">${text}</font>`;
  if (span.color === 'gray' || span.dim) return `<font color="grey">${text}</font>`;
  if (span.bold) return `**${text}**`;
  return text;
}

function trimTrailingBlankRows(rows: TerminalSnapshotRow[]): TerminalSnapshotRow[] {
  const next = [...rows];
  while (next[next.length - 1]?.text.trim() === '') {
    next.pop();
  }
  return next;
}

function truncateLine(text: string, maxChars: number, notes: Set<string>): string {
  if (text.length <= maxChars) {
    return text;
  }
  notes.add('Rows were truncated to fit Feishu card limits.');
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatFallback(input: RenderCurrentScreenCardInput, rows: TerminalSnapshotRow[], notes: Set<string>): string {
  const screen = rows.map((row) => row.text).join('\n');
  const noteText = notes.size > 0 ? `\n\n${Array.from(notes).join('\n')}` : '';
  return `Codex Current\nsession: ${input.sessionId}\nproject: ${input.projectId}\nstatus: ${input.status}\nsource: ${input.snapshot.source}\n\n${screen}${noteText}`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`');
}
```

- [ ] **Step 3: Run renderer tests**

```bash
npm test -- tests/feishu/CurrentScreenCard.test.ts
npm run build
```

Expected: PASS. If Feishu card markdown does not support `<font>`, keep the function but map unsupported styles to bold/plain text and update tests to assert the semantic text plus footer notes.

- [ ] **Step 4: Commit**

```bash
git add src/feishu/CurrentScreenCard.ts tests/feishu/CurrentScreenCard.test.ts
git commit -m "feat(feishu): render current terminal screen cards"
```

## Task 6: Wire `/current` Through SessionManager

**Files:**
- Modify: `src/commands/CommandRouter.ts`
- Modify: `tests/commands/CommandRouter.test.ts`
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Add failing command parser test**

Append to `tests/commands/CommandRouter.test.ts`:

```ts
it('parses current commands', () => {
  expect(parseIncomingText('/current')).toEqual({
    kind: 'command',
    name: 'current',
    args: [],
    raw: '/current',
  });
});
```

- [ ] **Step 2: Add failing SessionManager tests**

Append near existing tail tests in `tests/session/SessionManager.test.ts`:

```ts
it('returns no active session for /current before a session exists', async () => {
  const root = await createTmpDir();
  const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

  await expect(
    manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/current' }),
  ).resolves.toEqual({ reply: 'No active session.' });
});

it('returns a rendered current screen card from live PTY output', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  const created = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = created.reply.match(/sess_[^\s.]+/)![0]!;
  await runner.emitOutput(sessionId, '╭──── Codex ────╮\n');
  await runner.emitOutput(sessionId, '› 只读查看当前目录\n');

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/current' });

  expect(result.reply).toContain('Codex Current');
  expect(result.reply).toContain('› 只读查看当前目录');
  expect(result.renderedReply?.preferred.kind).toBe('card');
  expect(JSON.stringify(result.renderedReply?.preferred)).toContain('Codex Current');
});

it('falls back to raw log replay for /current when live terminal state is unavailable', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  const created = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = created.reply.match(/sess_[^\s.]+/)![0]!;
  await runner.emitOutput(sessionId, 'replayed screen\n');

  // Simulate a fresh manager after process restart: state/logs remain, live observer is empty.
  const restarted = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());
  const result = await restarted.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/current' });

  expect(result.reply).toContain('replayed screen');
  expect(result.renderedReply?.preferred.kind).toBe('card');
  expect(JSON.stringify(result.renderedReply?.preferred)).toContain('replay');
});

it('includes /current in help', async () => {
  const root = await createTmpDir();
  const manager = new SessionManager(sampleConfig(root), new FileStateStore(root), new FakeCodexRunner());

  const help = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/help' });

  expect(help.reply).toContain('/current');
});
```

- [ ] **Step 3: Run tests and verify they fail**

```bash
npm test -- tests/commands/CommandRouter.test.ts tests/session/SessionManager.test.ts
```

Expected: FAIL because `/current` is unknown and SessionManager is not wired.

- [ ] **Step 4: Add `current` command name**

In `src/commands/CommandRouter.ts`, add to `CommandName`:

```ts
  | 'current'
```

- [ ] **Step 5: Wire observer into `SessionManager`**

In `src/session/SessionManager.ts`, add imports:

```ts
import { CodexTerminalObserver } from '../output/CodexTerminalObserver.js';
import { replayTerminalSnapshot, type TerminalSnapshot } from '../output/TerminalScreenBuffer.js';
import { renderCurrentScreenCard } from '../feishu/CurrentScreenCard.js';
```

Add a private field:

```ts
  private readonly terminalObserver: CodexTerminalObserver;
```

Initialize it in the constructor after config is available:

```ts
    this.terminalObserver = new CodexTerminalObserver(this.config.output.terminalSnapshot);
```

If constructor field initialization style differs, place the assignment alongside existing dependency initialization.

- [ ] **Step 6: Write PTY chunks to observer**

In `startCodexSession`, change the `onOutput` callback to write observer state before persisting:

```ts
        onOutput: (text) => {
          this.terminalObserver.write(sessionId, text);
          return this.appendSessionOutput(sessionId, text).catch((error) =>
            this.recordBackgroundError('session.output_persist_failed', error, { sessionId }),
          );
        },
```

In `markExited(sessionId, exitCode)` or the method that updates exit state, add:

```ts
    this.terminalObserver.end(sessionId);
```

Place it before or after the store update; it must not throw. If needed:

```ts
    try {
      this.terminalObserver.end(sessionId);
    } catch (error) {
      await this.recordBackgroundError('session.terminal_snapshot_failed', error, { sessionId });
    }
```

- [ ] **Step 7: Implement `/current`**

In the command switch:

```ts
      case 'current':
        return this.current(input.chatId);
```

Add this method near `tail`:

```ts
  private async current(chatId: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }

    const session = await this.store.getSession(chat.currentSessionId);
    if (!session) {
      return { reply: 'No active session.' };
    }

    const snapshot = await this.currentSnapshot(session.id);
    const rendered = renderCurrentScreenCard({
      snapshot,
      config: this.config.output.terminalSnapshot,
      sessionId: session.id,
      projectId: session.projectId,
      status: session.status,
    });

    const reply = rendered.fallback.kind === 'text' ? rendered.fallback.text : 'Codex Current';
    return { reply, renderedReply: rendered };
  }

  private async currentSnapshot(sessionId: string): Promise<TerminalSnapshot> {
    const live = this.terminalObserver.snapshot(sessionId);
    if (live) {
      return live;
    }

    const raw = await this.store.tailSessionLogBytes(sessionId, this.config.output.terminalSnapshot.replayMaxBytes);
    if (raw) {
      return replayTerminalSnapshot(raw, this.config.output.terminalSnapshot);
    }

    const lines = await this.store.tailSessionLog(sessionId, 80);
    const sanitized = sanitizeTerminalOutput(lines);
    return {
      cols: this.config.output.terminalSnapshot.cols,
      rows: sanitized.readableLines.map((line) => ({ text: line, spans: [] })),
      capturedAt: new Date().toISOString(),
      source: 'fallback',
      truncated: false,
      notes: ['No terminal screen snapshot was available. Use /rawtail 80 for raw terminal logs.'],
    };
  }
```

- [ ] **Step 8: Update help**

In `helpText()`, add `/current` between `/status` and `/tail`:

```text
/current
```

- [ ] **Step 9: Run tests**

```bash
npm test -- tests/commands/CommandRouter.test.ts tests/session/SessionManager.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/commands/CommandRouter.ts tests/commands/CommandRouter.test.ts src/session/SessionManager.ts tests/session/SessionManager.test.ts
git commit -m "feat(session): add current terminal snapshot command"
```

## Task 7: Documentation and Final Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README command examples**

Add `/current` to the command list near `/status`, `/tail`, and `/rawtail`:

```text
/current
/tail [n]
/rawtail [n]
```

Add this bullet to the command descriptions:

```md
- `/current` returns a Feishu card snapshot of the current Codex TUI viewport. It uses the configured terminal snapshot dimensions and does not accept a line count.
```

- [ ] **Step 2: Run focused tests**

```bash
npm test -- tests/output/TerminalScreenBuffer.test.ts tests/output/CodexTerminalObserver.test.ts tests/feishu/CurrentScreenCard.test.ts tests/session/SessionManager.test.ts tests/config/loadConfig.test.ts tests/codex/CodexRunner.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit docs**

```bash
git add README.md
git commit -m "docs: document current terminal snapshot command"
```

## Plan Self-Review

- Spec coverage: `/current`, Feishu card rendering, `@xterm/headless`, live observer, raw-log replay, sanitizer fallback, config bounds, PTY dimension alignment, `/tail` compatibility, `/rawtail` compatibility, and tests are all covered.
- Scope: the plan does not rework `/tail` into a card and does not implement pixel-perfect ANSI rendering.
- Type consistency: `TerminalSnapshotConfig`, `TerminalSnapshot`, `TerminalScreenBuffer`, `CodexTerminalObserver`, and `renderCurrentScreenCard` names are consistent across tasks.
- Known implementation caveat: the exact `@xterm/headless` cell color API should be verified during Task 3. The public local snapshot interface must remain stable even if the internal cell API differs.
