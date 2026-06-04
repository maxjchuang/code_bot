# JS OOM PTY Log Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Codex PTY redraw noise and log tail operations from exhausting Node/V8 heap memory.

**Architecture:** Add bounded handling at every large-text boundary: debug PTY buffering, session log tail reads, and bot-visible raw/sanitized tail output. Keep the existing file store and sanitizer APIs mostly intact, but replace whole-file tail reads with a small reverse-tail reader and cap unbounded single-line buffers.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest, existing `FileStateStore`, `SessionManager`, and `TerminalOutputSanitizer`.

---

## File Structure

- Modify `src/session/SessionManager.ts`: cap debug PTY line buffers, cap live status chunks, cap raw tail reply lines before formatting.
- Modify `src/state/FileStateStore.ts`: replace whole-file `tailSessionLog()` with bounded byte-window tailing and cap `sessionLogLinesFrom()` fallback reads.
- Modify `src/output/TerminalOutputSanitizer.ts`: add per-line render guard so huge ANSI redraw lines cannot produce unbounded work.
- Modify `tests/session/SessionManager.test.ts`: cover debug PTY no-newline truncation and live status chunk capping.
- Modify `tests/state/FileStateStore.test.ts`: cover tailing from large logs without returning huge old content.
- Modify `tests/output/TerminalOutputSanitizer.test.ts`: cover huge redraw line truncation.

## Constants

Use these conservative limits unless implementation reveals a stronger local convention:

```ts
const MAX_PTY_DEBUG_BUFFER_CHARS = 16_384;
const MAX_LIVE_STATUS_CHARS = 32_768;
const MAX_TAIL_SCAN_BYTES = 1_048_576;
const MAX_LOG_LINE_CHARS = 16_384;
const MAX_SANITIZER_INPUT_LINE_CHARS = 65_536;
```

Rationale: Feishu replies are already much smaller than these limits, and useful Codex status/final lines should not need megabyte-sized single terminal rows.

### Task 1: Bound Debug PTY Buffer

**Files:**
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test near the existing debug PTY tests:

```ts
it('caps debug PTY buffering when terminal redraw output has no newline', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const logger = { info: vi.fn(), error: vi.fn() };
  const manager = new SessionManager(sampleConfig(root), store, runner, { logger, logLevel: 'debug' });

  await manager.handleText({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    text: '/new repo',
  });

  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  const redraw = '\u001b[?2026h\u001b[35;1H•Working\u001b[35;1H'.repeat(10_000);

  await runner.emitOutput(sessionId, redraw);
  await runner.emitOutput(sessionId, 'useful final line\n');

  expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('useful final line'));
  expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining(redraw));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "caps debug PTY buffering"
```

Expected: FAIL because the debug buffer retains the full no-newline redraw string or the process becomes slow.

- [ ] **Step 3: Implement the cap**

In `src/session/SessionManager.ts`, add constants near existing top-level constants:

```ts
const MAX_PTY_DEBUG_BUFFER_CHARS = 16_384;
const PTY_DEBUG_TRUNCATION_MARKER = '\n[debug pty output truncated: terminal redraw exceeded buffer limit]\n';
```

Replace the start of `logPtyDebugOutput()` with:

```ts
const previous = this.ptyDebugBuffers.get(sessionId) ?? '';
let buffered = `${previous}${text}`;
if (buffered.length > MAX_PTY_DEBUG_BUFFER_CHARS) {
  buffered = `${PTY_DEBUG_TRUNCATION_MARKER}${buffered.slice(-MAX_PTY_DEBUG_BUFFER_CHARS)}`;
}
const segments = buffered.split(/\r?\n/);
const remainder = segments.pop() ?? '';
this.ptyDebugBuffers.set(sessionId, remainder.slice(-MAX_PTY_DEBUG_BUFFER_CHARS));
```

Keep the existing loop over `segments`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "caps debug PTY buffering"
```

Expected: PASS.

- [ ] **Step 5: Run adjacent debug PTY tests**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "PTY output"
```

Expected: PASS.

### Task 2: Bound Live Status Accumulation

**Files:**
- Modify: `src/session/SessionManager.ts`
- Test: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test near live status/status command tests:

```ts
it('caps live status chunks collected from terminal redraw output', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner, {
    codexStatus: { quietMs: 1, timeoutMs: 100 },
  });

  await manager.handleText({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    text: '/new repo',
  });

  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  const statusPromise = manager.handleText({
    chatId: 'oc_1',
    chatType: 'group',
    userId: 'ou_1',
    text: '/status',
  });

  await runner.emitOutput(sessionId, '\u001b[?2026h\u001b[35;1H•Working'.repeat(10_000));
  await runner.emitOutput(sessionId, '\nmodel: gpt-5.5\n');

  const result = await statusPromise;
  expect(result.reply).toContain('gpt-5.5');
  expect(result.reply.length).toBeLessThan(10_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "caps live status chunks"
```

Expected: FAIL or very slow due to unbounded `waiter.chunks`.

- [ ] **Step 3: Implement bounded live status chunks**

In `src/session/SessionManager.ts`, add:

```ts
const MAX_LIVE_STATUS_CHARS = 32_768;
```

Add helper methods inside `SessionManager`:

```ts
private pushBoundedLiveStatusChunk(waiter: LiveStatusWaiter, text: string): void {
  waiter.chunks.push(text);
  let total = waiter.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  while (total > MAX_LIVE_STATUS_CHARS && waiter.chunks.length > 0) {
    const first = waiter.chunks[0]!;
    const overflow = total - MAX_LIVE_STATUS_CHARS;
    if (overflow >= first.length) {
      waiter.chunks.shift();
      total -= first.length;
      continue;
    }
    waiter.chunks[0] = first.slice(overflow);
    total -= overflow;
  }
}
```

In `notifyLiveStatusWaiters()`, replace:

```ts
waiter.chunks.push(text);
```

with:

```ts
this.pushBoundedLiveStatusChunk(waiter, text);
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "caps live status chunks"
```

Expected: PASS.

### Task 3: Replace Whole-File Tail Reads

**Files:**
- Modify: `src/state/FileStateStore.ts`
- Test: `tests/state/FileStateStore.test.ts`

- [ ] **Step 1: Write the failing tests**

Add imports at the top if needed:

```ts
import { stat } from 'node:fs/promises';
```

Add tests near existing session log tail tests:

```ts
it('tails session logs from the end without returning older oversized content', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  await store.appendSessionLog('session_large', `${'x'.repeat(2_000_000)}\n`);
  await store.appendSessionLog('session_large', 'last-one\nlast-two\n');

  await expect(store.tailSessionLog('session_large', 2)).resolves.toEqual(['last-one', 'last-two']);
});

it('caps a single oversized tailed log line', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  await store.appendSessionLog('session_long_line', `${'x'.repeat(100_000)}\nlast\n`);

  const lines = await store.tailSessionLog('session_long_line', 2);

  expect(lines).toHaveLength(2);
  expect(lines[0]!.length).toBeLessThanOrEqual(16_384 + 32);
  expect(lines[0]).toContain('[truncated');
  expect(lines[1]).toBe('last');
});
```

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npm test -- tests/state/FileStateStore.test.ts -t "session logs"
```

Expected: at least the oversized line cap test fails.

- [ ] **Step 3: Implement bounded tail reader**

In `src/state/FileStateStore.ts`, add constants:

```ts
const MAX_TAIL_SCAN_BYTES = 1_048_576;
const MAX_LOG_LINE_CHARS = 16_384;
```

Add helper:

```ts
function capLogLine(line: string): string {
  if (line.length <= MAX_LOG_LINE_CHARS) {
    return line;
  }
  return `[truncated ${line.length - MAX_LOG_LINE_CHARS} chars]${line.slice(-MAX_LOG_LINE_CHARS)}`;
}
```

Replace `tailSessionLog()` with logic that stats the file, reads only the final byte window, splits that window, drops a partial first line when the scan did not start at byte 0, removes trailing blank caused by terminal newline, caps each returned line, and returns the last `lineCount` lines:

```ts
async tailSessionLog(sessionId: string, lineCount: number): Promise<string[]> {
  await this.waitForPendingWrites();
  try {
    const filePath = this.sessionLogPath(sessionId);
    const fileStat = await stat(filePath);
    const start = Math.max(0, fileStat.size - MAX_TAIL_SCAN_BYTES);
    const handle = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(fileStat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split(/\r?\n/);
      if (start > 0) {
        lines.shift();
      }
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }
      return lines.slice(-lineCount).map(capLogLine);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}
```

Update imports to include `open`:

```ts
import { appendFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
```

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/state/FileStateStore.test.ts
```

Expected: PASS.

### Task 4: Bound `sessionLogLinesFrom()`

**Files:**
- Modify: `src/state/FileStateStore.ts`
- Test: `tests/state/FileStateStore.test.ts`

- [ ] **Step 1: Write failing test**

Add:

```ts
it('caps session log lines read from an old byte offset', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  await store.appendSessionLog('session_offset', `${'x'.repeat(2_000_000)}\ncurrent\n`);

  const lines = await store.sessionLogLinesFrom('session_offset', 0);

  expect(lines.at(-1)).toBe('current');
  expect(lines.every((line) => line.length <= 16_384 + 32)).toBe(true);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm test -- tests/state/FileStateStore.test.ts -t "old byte offset"
```

Expected: FAIL because the large line is returned uncapped.

- [ ] **Step 3: Implement bounded offset read**

Modify `sessionLogLinesFrom()` so it never reads more than `MAX_TAIL_SCAN_BYTES` from an old offset:

```ts
const filePath = this.sessionLogPath(sessionId);
const fileStat = await stat(filePath);
const start = Math.max(byteOffset, fileStat.size - MAX_TAIL_SCAN_BYTES);
const handle = await open(filePath, 'r');
try {
  const buffer = Buffer.alloc(fileStat.size - start);
  await handle.read(buffer, 0, buffer.length, start);
  const lines = buffer.toString('utf8').split(/\r?\n/);
  if (start > byteOffset) {
    lines.shift();
  }
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map(capLogLine);
} finally {
  await handle.close();
}
```

Keep the existing `ENOENT` behavior.

- [ ] **Step 4: Run tests**

Run:

```bash
npm test -- tests/state/FileStateStore.test.ts
```

Expected: PASS.

### Task 5: Guard Sanitizer Against Huge Terminal Lines

**Files:**
- Modify: `src/output/TerminalOutputSanitizer.ts`
- Test: `tests/output/TerminalOutputSanitizer.test.ts`

- [ ] **Step 1: Write failing test**

Add:

```ts
it('bounds work for oversized terminal-controlled lines', () => {
  const hugeRedraw = '\u001b[?2026h\u001b[35;1H•Working'.repeat(20_000);

  const result = sanitizeTerminalOutput([hugeRedraw, 'final useful line']);

  expect(result.hadControlSequences).toBe(true);
  expect(result.readableLines).toEqual(['final useful line']);
  expect(result.removedLineCount).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify failure or slow path**

Run:

```bash
npm test -- tests/output/TerminalOutputSanitizer.test.ts -t "oversized terminal-controlled"
```

Expected: FAIL if output is not dropped, or noticeably slow before the guard.

- [ ] **Step 3: Implement input line guard**

In `src/output/TerminalOutputSanitizer.ts`, add:

```ts
const MAX_SANITIZER_INPUT_LINE_CHARS = 65_536;
```

At the top of the loop in `sanitizeTerminalOutput()`:

```ts
if (line.length > MAX_SANITIZER_INPUT_LINE_CHARS && line.includes('\u001b')) {
  hadControlSequences = true;
  removedLineCount += 1;
  continue;
}
```

This intentionally drops oversized terminal-controlled rows, because they are almost always TUI redraw noise and are expensive to render.

- [ ] **Step 4: Run sanitizer tests**

Run:

```bash
npm test -- tests/output/TerminalOutputSanitizer.test.ts
```

Expected: PASS.

### Task 6: Full Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts tests/state/FileStateStore.test.ts tests/output/TerminalOutputSanitizer.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run TypeScript build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual memory smoke test**

Run:

```bash
node --max-old-space-size=256 -e "const s='\\u001b[?2026h\\u001b[35;1H•Working'.repeat(200000); console.log(s.length)"
```

Expected: command prints a length and exits. Then run the app tests above under the same small heap:

```bash
NODE_OPTIONS=--max-old-space-size=256 npm test -- tests/session/SessionManager.test.ts tests/state/FileStateStore.test.ts tests/output/TerminalOutputSanitizer.test.ts
```

Expected: PASS without OOM.

### Task 7: Operational Rollout

**Files:**
- Modify only if needed: `.code-bot/config.json`

- [ ] **Step 1: Set production config to info unless actively debugging**

For local production bot runtime, set:

```json
"logLevel": "info"
```

Expected: debug PTY console logging remains opt-in.

- [ ] **Step 2: Restart bot**

Run the existing deployment/start command used for this workspace. If running manually:

```bash
npm run build
npm start
```

Expected: bot starts and `startup.ready` appears if log level allows it.

- [ ] **Step 3: Verify commands**

Send these through the bot:

```text
/status
/tail 50
/rawtail 50
```

Expected: replies are bounded, no Feishu 400 due to oversized raw output, and no process memory spike.

## Self-Review

- Spec coverage: covers debug PTY OOM root cause, whole-file tail read amplification, sanitizer oversized-line cost, and operational log-level mitigation.
- Placeholder scan: no TBD or open-ended implementation steps remain.
- Type consistency: all referenced files and methods already exist; new constants and helpers are introduced before use.
