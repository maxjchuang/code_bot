# Terminal Output Sanitization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Feishu `/tail` show readable Codex output while preserving exact raw PTY output through `/rawtail`.

**Architecture:** Keep raw PTY logs as the source of truth in `FileStateStore`. Add a side-effect-free `TerminalOutputSanitizer` under `src/output/` and make `SessionManager` route `/tail` through it while `/rawtail` bypasses it. Command parsing and help text are extended narrowly for `/rawtail`.

**Tech Stack:** Node.js 20+, TypeScript, Vitest, native string/regexp processing, existing file-backed state store.

---

## File Map

- Create `src/output/TerminalOutputSanitizer.ts`: reusable terminal output cleaning logic.
- Create `tests/output/TerminalOutputSanitizer.test.ts`: sanitizer unit tests using realistic Codex TUI fragments.
- Modify `src/commands/CommandRouter.ts`: add `rawtail` to the command name union.
- Modify `tests/commands/CommandRouter.test.ts`: add parser coverage for `/rawtail`.
- Modify `src/session/SessionManager.ts`: route `/tail` through sanitizer and add `/rawtail`.
- Modify `tests/session/SessionManager.test.ts`: command behavior coverage for sanitized tail, empty readable tail, rawtail, validation, and help.
- Modify `README.md`: document readable `/tail` and raw `/rawtail`.

## Task 1: Terminal Output Sanitizer

**Files:**
- Create: `src/output/TerminalOutputSanitizer.ts`
- Create: `tests/output/TerminalOutputSanitizer.test.ts`

- [ ] **Step 1: Write failing sanitizer tests**

Create `tests/output/TerminalOutputSanitizer.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sanitizeTerminalOutput } from '../../src/output/TerminalOutputSanitizer.js';

describe('sanitizeTerminalOutput', () => {
  it('strips ANSI, OSC, and terminal mode control sequences', () => {
    const result = sanitizeTerminalOutput([
      '\u001b[?2004h\u001b[1;1H\u001b[J\u001b[38;5;3m⚠ failed to start\u001b[39m',
      '\u001b]0;code_bot\u0007plain text\u001b[?25h',
    ]);

    expect(result.hadControlSequences).toBe(true);
    expect(result.readableLines).toEqual(['⚠ failed to start', 'plain text']);
    expect(result.removedLineCount).toBe(0);
  });

  it('filters Codex TUI banner and redraw noise while preserving useful lines', () => {
    const result = sanitizeTerminalOutput([
      '\u001b[2m╭───────────────────────────────────────╮',
      '│ >_  OpenAI Codex  (v0.133.0)            │',
      '│ model:      loading    /model to change │',
      '╰───────────────────────────────────────╯',
      '• Starting MCP servers (4/7): codex_apps, figma, scm (0s • esc to interrupt)',
      '⚠ The figma MCP server is not logged in. Run `codex mcp login figma`.',
      '⚠ MCP startup incomplete (failed: FeishuProjectMcp, codebase, figma, scm)',
      '› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
      '/Users/bytedance/Projects/github/code_bot',
      'README.md',
      'src',
      'tests',
    ]);

    expect(result.readableLines).toEqual([
      '⚠ The figma MCP server is not logged in. Run `codex mcp login figma`.',
      '⚠ MCP startup incomplete (failed: FeishuProjectMcp, codebase, figma, scm)',
      '› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件',
      '/Users/bytedance/Projects/github/code_bot',
      'README.md',
      'src',
      'tests',
    ]);
    expect(result.removedLineCount).toBeGreaterThanOrEqual(5);
  });

  it('deduplicates adjacent repeated lines and compresses blank lines', () => {
    const result = sanitizeTerminalOutput(['Tip: Try the Codex App.', 'Tip: Try the Codex App.', '', '', 'done', 'done']);

    expect(result.readableLines).toEqual(['Tip: Try the Codex App.', '', 'done']);
    expect(result.removedLineCount).toBe(3);
  });

  it('returns empty readable lines when only redraw noise remains', () => {
    const result = sanitizeTerminalOutput([
      '\u001b[?2026h\u001b[14;2H\u001b[0m\u001b[49m\u001b[K',
      '╭────────────────────╮',
      '╰────────────────────╯',
      '• Starting MCP servers (5/7): scm (1s • esc to interrupt)',
      '\u001b]0;⠹ code_bot\u0007',
    ]);

    expect(result.readableLines).toEqual([]);
    expect(result.removedLineCount).toBeGreaterThan(0);
    expect(result.hadControlSequences).toBe(true);
  });
});
```

- [ ] **Step 2: Run the sanitizer tests to verify they fail**

Run:

```bash
npm test -- tests/output/TerminalOutputSanitizer.test.ts
```

Expected: FAIL because `src/output/TerminalOutputSanitizer.ts` does not exist.

- [ ] **Step 3: Implement the sanitizer**

Create `src/output/TerminalOutputSanitizer.ts`:

```ts
export interface SanitizedTerminalOutput {
  readableLines: string[];
  removedLineCount: number;
  hadControlSequences: boolean;
}

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|[PX^_].*?(?:\u001b\\)|[@-Z\\-_])/g;
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const BOXDRAWING_PATTERN = /^[\s╭╮╰╯│─┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]+$/u;
const WARNING_PATTERN = /(⚠|warning|error|failed|failure|not logged in|denied|invalid|missing|cannot|can't)/i;

export function sanitizeTerminalOutput(lines: string[]): SanitizedTerminalOutput {
  const readableLines: string[] = [];
  let removedLineCount = 0;
  let hadControlSequences = false;
  let previousLine: string | undefined;
  let previousWasBlank = false;

  for (const line of lines) {
    const stripped = stripTerminalControl(line);
    hadControlSequences = hadControlSequences || stripped.hadControlSequences;
    const normalized = normalizeReadableLine(stripped.text);

    if (shouldDropLine(normalized)) {
      removedLineCount += 1;
      continue;
    }

    if (normalized === '') {
      if (previousWasBlank) {
        removedLineCount += 1;
        continue;
      }
      previousWasBlank = true;
      previousLine = normalized;
      readableLines.push(normalized);
      continue;
    }

    previousWasBlank = false;
    if (normalized === previousLine) {
      removedLineCount += 1;
      continue;
    }

    previousLine = normalized;
    readableLines.push(normalized);
  }

  while (readableLines[0] === '') {
    readableLines.shift();
    removedLineCount += 1;
  }
  while (readableLines[readableLines.length - 1] === '') {
    readableLines.pop();
    removedLineCount += 1;
  }

  return { readableLines, removedLineCount, hadControlSequences };
}

function stripTerminalControl(text: string): { text: string; hadControlSequences: boolean } {
  const withoutAnsi = text.replace(ANSI_PATTERN, '');
  const withoutControls = withoutAnsi.replace(C0_CONTROL_PATTERN, '');
  return {
    text: withoutControls,
    hadControlSequences: withoutControls !== text,
  };
}

function normalizeReadableLine(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.。！？:：])/g, '$1')
    .trim();
}

function shouldDropLine(line: string): boolean {
  if (line === '') {
    return false;
  }
  if (WARNING_PATTERN.test(line)) {
    return false;
  }
  if (line.startsWith('› ')) {
    return false;
  }
  if (BOXDRAWING_PATTERN.test(line)) {
    return true;
  }
  if (/^│.*(OpenAI Codex|model:|directory:|\/model to change).*│?$/i.test(line)) {
    return true;
  }
  if (/^[•·]?\s*Starting MCP servers\s*\([^)]+\):/i.test(line)) {
    return true;
  }
  if (/^\(?\d+s\s*•\s*esc to interrupt\)?$/i.test(line)) {
    return true;
  }
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\S*$/.test(line)) {
    return true;
  }
  if (/^[›•·*_\-|\s]+$/.test(line)) {
    return true;
  }
  if (line.length <= 2 && !/[A-Za-z0-9\u4e00-\u9fff]/u.test(line)) {
    return true;
  }
  return false;
}
```

- [ ] **Step 4: Run sanitizer tests**

Run:

```bash
npm test -- tests/output/TerminalOutputSanitizer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit sanitizer**

```bash
git add src/output/TerminalOutputSanitizer.ts tests/output/TerminalOutputSanitizer.test.ts
git commit -m "feat(output): 添加终端输出清洗器"
```

## Task 2: Rawtail Command Parsing

**Files:**
- Modify: `src/commands/CommandRouter.ts`
- Modify: `tests/commands/CommandRouter.test.ts`

- [ ] **Step 1: Write failing parser test**

Append this test to `tests/commands/CommandRouter.test.ts`:

```ts
it('parses rawtail commands', () => {
  expect(parseIncomingText('/rawtail 120')).toEqual({
    kind: 'command',
    name: 'rawtail',
    args: ['120'],
    raw: '/rawtail 120',
  });
});
```

- [ ] **Step 2: Run parser tests**

Run:

```bash
npm test -- tests/commands/CommandRouter.test.ts
```

Expected: PASS at runtime today, but TypeScript build will still need the `CommandName` union update before `rawtail` is a first-class command.

- [ ] **Step 3: Add `rawtail` to `CommandName`**

Modify `src/commands/CommandRouter.ts` so the union includes `rawtail` next to `tail`:

```ts
export type CommandName =
  | 'help'
  | 'projects'
  | 'use'
  | 'new'
  | 'send'
  | 'status'
  | 'tail'
  | 'rawtail'
  | 'stop'
  | 'sessions'
  | 'approve'
  | 'reject';
```

- [ ] **Step 4: Run parser tests and build**

Run:

```bash
npm test -- tests/commands/CommandRouter.test.ts
npm run build
```

Expected: both commands pass.

- [ ] **Step 5: Commit parser update**

```bash
git add src/commands/CommandRouter.ts tests/commands/CommandRouter.test.ts
git commit -m "feat(commands): 识别 rawtail 命令"
```

## Task 3: SessionManager Tail Behavior

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `tests/session/SessionManager.test.ts`

- [ ] **Step 1: Add failing SessionManager tests**

Append these tests inside the existing `describe('SessionManager', () => { ... })` block in `tests/session/SessionManager.test.ts`:

```ts
it('sanitizes /tail output for Feishu readability', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;

  await runner.emitOutput(sessionId, '\u001b[?2004h\u001b[1;1H\u001b[J');
  await runner.emitOutput(sessionId, '╭────────────────────╮\n');
  await runner.emitOutput(sessionId, '│ >_ OpenAI Codex │\n');
  await runner.emitOutput(sessionId, '⚠ MCP startup incomplete (failed: figma)\n');
  await runner.emitOutput(sessionId, '› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件\n');
  await runner.emitOutput(sessionId, '/Users/bytedance/Projects/github/code_bot\n');

  const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

  expect(tail.reply).toContain('```text');
  expect(tail.reply).toContain('⚠ MCP startup incomplete (failed: figma)');
  expect(tail.reply).toContain('› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件');
  expect(tail.reply).toContain('/Users/bytedance/Projects/github/code_bot');
  expect(tail.reply).not.toContain('\u001b[');
  expect(tail.reply).not.toContain('OpenAI Codex');
  expect(tail.reply).not.toContain('╭');
});

it('returns a helpful message when /tail has no readable output', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  await runner.emitOutput(sessionId, '\u001b[?2026h\u001b[14;2H\u001b[0m\u001b[49m\u001b[K\n');
  await runner.emitOutput(sessionId, '╭────────────────────╮\n╰────────────────────╯\n');

  const tail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/tail 20' });

  expect(tail.reply).toBe('No readable output yet. Use /rawtail 80 for raw terminal logs.');
});

it('returns raw terminal output with /rawtail', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const runner = new FakeCodexRunner();
  const manager = new SessionManager(sampleConfig(root), store, runner);

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });
  const sessionId = (await store.getChat('oc_1'))!.currentSessionId!;
  await runner.emitOutput(sessionId, '\u001b[?2004hraw terminal line\n');

  const rawtail = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/rawtail 10' });

  expect(rawtail.reply).toContain('```text');
  expect(rawtail.reply).toContain('\u001b[?2004hraw terminal line');
});

it('validates /rawtail count like /tail', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root);
  const manager = new SessionManager(sampleConfig(root), store, new FakeCodexRunner());

  await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/new repo' });

  for (const value of ['10abc', '1e3', '0', '-1']) {
    const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: `/rawtail ${value}` });
    expect(result.reply).toBe('Invalid tail count.');
  }
});
```

Also update the existing help test in `tests/session/SessionManager.test.ts` so it asserts:

```ts
expect(help.reply).toContain('/rawtail [n]');
```

- [ ] **Step 2: Run SessionManager tests to verify they fail**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: FAIL because `/tail` is still raw, `/rawtail` is unknown, and help does not list `/rawtail`.

- [ ] **Step 3: Import sanitizer in SessionManager**

Modify the imports in `src/session/SessionManager.ts`:

```ts
import { formatTail } from '../output/OutputFormatter.js';
import { sanitizeTerminalOutput } from '../output/TerminalOutputSanitizer.js';
```

- [ ] **Step 4: Add rawtail switch case and refactor tail methods**

In the command switch in `src/session/SessionManager.ts`, add:

```ts
      case 'rawtail':
        return this.rawTail(input.chatId, parsed.args[0]);
```

Replace the current `tail()` method with these methods:

```ts
  private async tail(chatId: string, requestedCount?: string): Promise<BotTextResult> {
    const rawLines = await this.tailRawLines(chatId, requestedCount);
    if ('reply' in rawLines) {
      return rawLines;
    }
    const sanitized = sanitizeTerminalOutput(rawLines.lines);
    if (sanitized.readableLines.length === 0) {
      return { reply: 'No readable output yet. Use /rawtail 80 for raw terminal logs.' };
    }
    return { reply: formatTail(sanitized.readableLines) };
  }

  private async rawTail(chatId: string, requestedCount?: string): Promise<BotTextResult> {
    const rawLines = await this.tailRawLines(chatId, requestedCount);
    if ('reply' in rawLines) {
      return rawLines;
    }
    return { reply: formatTail(rawLines.lines) };
  }

  private async tailRawLines(chatId: string, requestedCount?: string): Promise<BotTextResult | { lines: string[] }> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }

    let count = 80;
    if (requestedCount !== undefined) {
      if (!/^[1-9]\d*$/.test(requestedCount)) {
        return { reply: 'Invalid tail count.' };
      }
      count = Number.parseInt(requestedCount, 10);
    }

    return { lines: await this.store.tailSessionLog(chat.currentSessionId, count) };
  }
```

- [ ] **Step 5: Add `/rawtail [n]` to help text**

Update `helpText()` in `src/session/SessionManager.ts`:

```ts
  private helpText(): string {
    const commands = '/help\n/projects\n/use <project>\n/new [project]\n/send <text>\n/status\n/tail [n]\n/rawtail [n]\n/stop\n/sessions\n/approve <id>\n/reject <id>';
    const restrictions = [
      'Restrictions:',
      `- Allowed users: ${this.config.allowedUsers.length}`,
      `- Allowed chats: ${this.config.allowedChatIds.length}`,
      `- Projects: ${this.config.projects.map((project) => project.id).join(', ') || 'none'}`,
    ].join('\n');
    return `${commands}\n\n${restrictions}`;
  }
```

- [ ] **Step 6: Run SessionManager tests**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run focused output and command tests**

Run:

```bash
npm test -- tests/output/TerminalOutputSanitizer.test.ts tests/output/OutputFormatter.test.ts tests/commands/CommandRouter.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit SessionManager integration**

```bash
git add src/session/SessionManager.ts tests/session/SessionManager.test.ts src/commands/CommandRouter.ts tests/commands/CommandRouter.test.ts
git commit -m "feat(session): 添加可读 tail 与 rawtail"
```

## Task 4: README and Final Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README command reference**

In `README.md`, update the command reference block to include `/rawtail [n]` after `/tail [n]`:

```text
/help
/projects
/use <project>
/new [project]
/send <text>
/status
/tail [n]
/rawtail [n]
/stop
/sessions
/approve <id>
/reject <id>
```

- [ ] **Step 2: Update README command notes**

Replace the current `/tail` note with:

```md
- `/tail [n]` returns the last `n` readable log lines from the active session after removing terminal control sequences and TUI redraw noise; default is 80.
- `/rawtail [n]` returns the last `n` raw PTY log lines for debugging; default is 80.
```

- [ ] **Step 3: Run full verification**

Run:

```bash
npm test
npm run build
```

Expected:

- Vitest passes all tests.
- TypeScript build succeeds.

- [ ] **Step 4: Commit README update**

```bash
git add README.md
git commit -m "docs(readme): 说明可读 tail 与 rawtail"
```

## Final Manual Smoke Check

After all tasks are complete and merged into the runtime branch:

1. Start the bot:

   ```bash
   npm run dev
   ```

2. In an allowed Feishu private chat, run:

   ```text
   /new code-bot
   /tail 80
   /rawtail 20
   ```

Expected:

- `/tail 80` does not show raw ANSI/OSC control sequences such as `[?2004h`, `[1;1H`, `]0;code_bot`, or repeated Codex TUI redraw frames.
- `/tail 80` keeps useful warnings, errors, user input, paths, and answer text.
- `/rawtail 20` still shows exact raw PTY output for debugging.

