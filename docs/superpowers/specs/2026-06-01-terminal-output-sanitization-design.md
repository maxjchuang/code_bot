# Terminal Output Sanitization Design

## Context

Issue: https://github.com/maxjchuang/code_bot/issues/4

During real Feishu smoke testing, Codex sessions started successfully, but `/tail` returned raw PTY terminal output. Feishu displayed terminal control sequences, cursor movement, redraw frames, colors, title updates, spinner animation, and Codex TUI layout bytes as literal text. The result was technically accurate but not readable in chat.

Current behavior:

- `CodexRunner` receives raw PTY output.
- `SessionManager.appendSessionOutput()` persists raw text through `FileStateStore.appendSessionLog()`.
- `/tail [n]` reads raw log lines and calls `formatTail(lines)`.
- No sanitizer runs before Feishu replies.

The raw log is still valuable for debugging and must remain available.

## Goals

- Make `/tail [n]` return human-readable output by default.
- Preserve raw PTY logs locally without modification.
- Add `/rawtail [n]` for debugging exact terminal output.
- Keep the output cleaning logic reusable for future pushed Codex output.
- Avoid broad behavior changes to Codex session lifecycle, Feishu gateway, or persistence.

## Non-Goals

- Do not implement proactive Codex output push to Feishu in this change.
- Do not infer or summarize the final Codex answer.
- Do not implement a full terminal emulator or screen-buffer renderer.
- Do not delete, rewrite, or truncate raw local session logs.
- Do not make `config.output` chunking fully enforced across all replies in this design.

## Selected Approach

Use a medium-strength sanitizer:

1. Remove terminal protocol/control sequences.
2. Filter obvious TUI redraw noise line by line.
3. Preserve warning/error lines, user input, Codex answer text, paths, file lists, and command output.
4. Deduplicate adjacent repeated lines and compress repeated blank lines.

This is intentionally simpler than a terminal renderer, but strong enough to solve the Feishu readability problem. `/rawtail` remains the escape hatch when exact bytes matter.

## Components

### Terminal Output Sanitizer

Add a reusable sanitizer as `src/output/TerminalOutputSanitizer.ts`.

Suggested interface:

```ts
export interface SanitizedTerminalOutput {
  readableLines: string[];
  removedLineCount: number;
  hadControlSequences: boolean;
}

export function sanitizeTerminalOutput(lines: string[]): SanitizedTerminalOutput;
```

Responsibilities:

- Accept raw PTY log lines.
- Strip terminal control sequences.
- Apply line-level TUI noise filtering.
- Return readable lines and simple diagnostics.

The sanitizer must be deterministic and side-effect free so it can be reused later for pushed output.

### SessionManager Commands

`/tail [n]`:

- Keeps existing default count of 80.
- Keeps strict positive integer validation.
- Reads raw log lines from `FileStateStore.tailSessionLog()`.
- Sanitizes the lines.
- Returns formatted readable output.
- If no readable output remains, returns:

```text
No readable output yet. Use /rawtail 80 for raw terminal logs.
```

`/rawtail [n]`:

- New command.
- Uses the same session lookup and count validation as `/tail`.
- Reads raw log lines.
- Bypasses sanitizer.
- Returns raw output through the existing fenced code block formatter.

`/help`:

- Add `/rawtail [n]`.

### FileStateStore

No storage behavior changes.

Raw PTY output remains the only persisted log format:

```text
.code-bot/logs/sessions/<sessionId>.log
```

## Sanitization Rules

### Control Sequence Removal

Strip:

- ANSI CSI sequences such as colors, cursor movement, clear screen, scroll regions, and erase line.
- OSC sequences such as terminal title updates, for example `]0;code_bot`.
- Bracketed paste, cursor show/hide, alternate screen, and similar terminal modes.
- Non-printing C0 control characters except newline and tab.

### Noise Line Filtering

Filter lines that are only terminal UI noise:

- Pure box drawing and decoration lines.
- Codex startup banner frame lines such as `╭──`, `│ >_ OpenAI Codex`, and `╰──`.
- Spinner/redraw fragments from repeated status animation.
- Lines that become only isolated prompt markers, cursor artifacts, or short non-semantic redraw fragments.
- Adjacent duplicate lines.
- Repeated blank lines beyond a single blank line.

### Preserved Content

Keep lines with useful meaning:

- Warnings and errors, including text containing `warning`, `error`, `failed`, `not logged in`, or `⚠`.
- User-visible prompt/input text such as `› 只读查看当前目录...`, normalized to readable text.
- Codex response text.
- Paths, file names, command output, and file lists.
- Useful status text when it is not just redraw noise.
- A repeated `Tip:` line only once.

When uncertain, keep text rather than drop it. The default failure mode should be slightly noisy, not data loss.

## User-Facing Behavior

Readable tail example:

```text
⚠ The figma MCP server is not logged in. Run `codex mcp login figma`.
⚠ MCP startup incomplete (failed: FeishuProjectMcp, codebase, figma, scm)
› 只读查看当前目录，回复 pwd 和文件列表，不要修改文件
```

Empty readable tail:

```text
No readable output yet. Use /rawtail 80 for raw terminal logs.
```

Raw tail:

````text
```text
<unmodified PTY log lines>
```
````

## Error Handling

- No active session: keep current `No active session.` behavior.
- Invalid count: keep current `Invalid tail count.` behavior.
- Missing log file: treat as empty output.
- Sanitizer failures should not become user-visible crashes. The sanitizer should be written defensively and keep unrecognized printable text.
- `/rawtail` may be noisy by design, but still uses fenced code blocks so it does not break Feishu message layout.

## Testing

Add unit tests for sanitizer behavior:

- Strips ANSI color, cursor movement, clear-screen, OSC title, and terminal mode sequences.
- Preserves warning/error/not-logged-in lines.
- Preserves user input lines and normal command output.
- Filters Codex banner/frame/spinner/redraw noise from a recorded sample.
- Deduplicates adjacent repeated lines.
- Compresses repeated blank lines.
- Returns empty `readableLines` when no meaningful text remains.

Add `SessionManager` command tests:

- `/tail` returns sanitized output.
- `/tail` returns the no-readable-output message when sanitizer output is empty.
- `/rawtail` returns raw unmodified output.
- `/rawtail` uses the same default count and strict positive integer validation as `/tail`.
- `/help` includes `/rawtail [n]`.

Run:

```bash
npm test
npm run build
```

## Acceptance Criteria

- Feishu `/tail 80` no longer displays raw terminal control sequences for Codex TUI output.
- `/tail 80` keeps useful warning/error/user input/answer text readable.
- `/rawtail 80` still exposes exact raw PTY log output for debugging.
- Raw session log persistence remains unchanged.
- Existing tests pass, and new sanitizer/session command tests cover the recorded failure shape.
