# Current TUI Snapshot Design

## Context

`/tail` currently tries to make raw Codex PTY output readable by cleaning terminal control
sequences and filtering redraw noise. That improves plain text output, but it is still the
wrong model for Codex's full-screen TUI: cursor movement, erase-line operations, status
bars, box drawing, and repeated redraw frames can leave artifacts, drop useful text, or mix
old and new frames.

The desired behavior is to show what the Codex TUI looked like at the time of inspection.
This requires reconstructing terminal screen state, not just filtering log lines.

## Goals

- Add `/current` to show a current Codex TUI screen snapshot.
- Render `/current` as a Feishu card with line-level components that preserve layout and
  common styling as much as practical.
- Use `@xterm/headless` as the terminal state machine for PTY output.
- Keep `/tail [n]` as plain text output for copying, searching, and compatibility.
- Keep `/rawtail [n]` as exact raw PTY output for debugging.
- Keep raw session logs as the durable source of truth.
- Bound replay, snapshot, and card-rendering work so a large PTY log cannot make the bot
  slow or produce an oversized Feishu payload.

## Non-Goals

- Do not make `/current` accept a user-supplied row count.
- Do not pursue pixel-perfect terminal rendering.
- Do not preserve every ANSI color, background color, cursor shape, or mouse state.
- Do not change `/tail` into a Feishu card in the first implementation.
- Do not remove the existing sanitizer; it remains a fallback path.

## User-Facing Behavior

### `/current`

`/current` returns a Feishu card titled `Codex Current`.

The card represents the current terminal viewport for the active Codex session:

- It uses configured terminal dimensions, defaulting to the current PTY size of `120 x 40`.
- It renders rows as card components, preserving terminal layout, indentation, box drawing,
  status bars, warnings, prompts, and visible Codex output.
- It uses bounded style mapping for common terminal styles and degrades complex rows to
  plain text.
- It does not require or accept a line-count argument.

If no active session exists, `/current` returns the same no-session behavior as `/tail`:

```text
No active session.
```

If a rich card cannot be produced, the command falls back to a plain text snapshot. If no
screen snapshot can be produced, it points users to `/rawtail 80`.

### Existing Commands

- `/tail [n]` stays a readable plain text tail. Reworking `/tail` to use terminal replay is
  outside the first `/current` implementation.
- `/rawtail [n]` stays exact raw PTY output in a fenced block.
- `/help` includes `/current`.

## Configuration

Extend `output` configuration with `terminalSnapshot`:

```json
{
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
  }
}
```

Default behavior:

- `cols: 120`, `rows: 40`: match the current `node-pty` spawn size.
- `scrollback: 200`: allow a small history buffer while keeping memory bounded.
- `replayMaxBytes: 262144`: replay at most the newest 256 KiB of raw PTY log after restart.
- `cardMaxRows: 40`: render the visible terminal height by default.
- `cardMaxLineChars: 160`: prevent horizontally oversized card rows.
- `maxStyledSegmentsPerLine: 8`: cap row complexity; more complex rows degrade to plain text.

The PTY spawn size and the headless terminal size should read from the same configuration so
they do not diverge.

## Architecture

### `TerminalScreenBuffer`

`TerminalScreenBuffer` wraps `@xterm/headless`.

It owns terminal state and exposes a small project-local interface:

```ts
interface TerminalScreenBuffer {
  write(chunk: string): void;
  snapshot(): TerminalSnapshot;
  resetAndReplay(input: string | string[]): TerminalSnapshot;
}
```

Responsibilities:

- Create a headless terminal with configured `cols`, `rows`, and `scrollback`.
- Write raw PTY output into the terminal.
- Extract the current viewport and limited style metadata into `TerminalSnapshot`.
- Reset and replay bounded raw log content when live in-memory state is unavailable.
- Hide `@xterm/headless` API details from the rest of the application.

### `TerminalSnapshot`

`TerminalSnapshot` is a renderer-neutral model of the current terminal screen.

It should contain:

- terminal `cols` and `rows`
- visible rows, in screen order
- each row's plain text
- optional bounded style spans for common styles
- metadata such as `source: 'live' | 'replay' | 'fallback'`, `capturedAt`, and truncation flags

Rows may preserve empty lines in the viewport. Trailing empty lines can be trimmed only when
needed to fit Feishu card limits.

### `CodexTerminalObserver`

`CodexTerminalObserver` maintains live terminal buffers:

```ts
sessionId -> TerminalScreenBuffer
```

It receives the same PTY chunks that are written to raw session logs. For each chunk:

1. append to raw log through the existing persistence path
2. write to the session's `TerminalScreenBuffer`

When a session exits, the observer may keep the final snapshot in memory for a bounded time
so `/current` can still show the just-finished screen. The durable fallback remains raw log
replay.

### `CurrentScreenCardRenderer`

`CurrentScreenCardRenderer` converts `TerminalSnapshot` into:

```ts
{ preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage }
```

The preferred message is a Feishu card. The fallback is plain text.

Card structure:

- header title: `Codex Current`
- top summary: session, project, status, and capture time when available
- body rows: one card component per terminal row
- footer notes: replay fallback, truncation, style degradation, or rawtail hint

The renderer does not read raw PTY logs and does not know how to emulate a terminal.

### `SessionManager.current()`

`SessionManager` adds `/current` handling:

1. Resolve the active session for the chat.
2. Ask `CodexTerminalObserver` for a live snapshot.
3. If live state is unavailable, read the newest bounded raw log bytes and replay them through
   `TerminalScreenBuffer`.
4. If replay fails, use the existing sanitizer/plain text fallback.
5. Render with `CurrentScreenCardRenderer`.

## Rendering Rules

`/current` uses card components for rows rather than one large code block.

Priority order:

1. Preserve layout: row order, indentation, box drawing, status-line placement, prompts, and
   visible text.
2. Preserve common styles with a hard cap.
3. Keep payload size safe for Feishu.

Style mapping is intentionally small:

- warnings and yellow-like ANSI styles map to a warning color where Feishu supports it
- errors and red-like ANSI styles map to an error color
- success and green-like ANSI styles map to a success color
- dim text maps to a muted style where practical
- bold maps to bold text where practical

Rows degrade to plain text when:

- style spans exceed `maxStyledSegmentsPerLine`
- the style combination is unsupported
- preserving styles would make the card payload too large

Long rows are truncated to `cardMaxLineChars` and marked with an ellipsis. If the whole card
is too large, the renderer trims trailing blank rows, then degrades styled rows to plain
text, then reduces displayed rows and adds a footer note.

## Data Flow

Runtime:

```text
Codex PTY onData
  -> append raw session log
  -> CodexTerminalObserver.write(sessionId, chunk)
  -> TerminalScreenBuffer.write(chunk)
```

`/current`:

```text
/current
  -> resolve active session
  -> live observer snapshot
  -> if missing, bounded raw log replay
  -> if replay fails, sanitizer/plain text fallback
  -> CurrentScreenCardRenderer
  -> Feishu card preferred, text fallback
```

## Fallbacks

Fallback order:

1. live `@xterm/headless` snapshot
2. raw log replay snapshot
3. existing sanitizer plain text
4. message that suggests `/rawtail 80`

Card-send failure should use the existing rendered-message fallback path and send the plain
text snapshot.

## Testing

### `TerminalScreenBuffer`

- Renders ANSI cursor movement, erase-line, erase-screen, and redraw sequences into the
  expected final viewport.
- Preserves Codex-like TUI borders, status bars, prompts, warnings, and Chinese text.
- Uses configured `cols`, `rows`, and `scrollback`.
- Bounds replay with `replayMaxBytes`.

### `CurrentScreenCardRenderer`

- Renders a normal `TerminalSnapshot` as a Feishu card.
- Includes session/project/status/capture metadata when provided.
- Truncates long rows.
- Degrades rows with too many style spans.
- Degrades oversized payloads predictably.
- Produces readable plain text fallback.

### `SessionManager`

- `/current` without an active session returns `No active session.`
- `/current` with live observer state returns a card.
- `/current` falls back to raw log replay when live state is unavailable.
- `/current` falls back to sanitized plain text if replay fails.
- `/help` includes `/current`.
- `/tail` and `/rawtail` behavior remains compatible.

### Commands

Run:

```bash
npm test
npm run build
```

## Acceptance Criteria

- `/current` shows a Feishu card that resembles the current Codex TUI viewport.
- The command requires no row-count argument.
- Common layout and styling survive typical Codex TUI redraws.
- Large logs and complex terminal output are bounded and degrade predictably.
- `/tail [n]` and `/rawtail [n]` remain available and compatible.
- Raw PTY logs remain unchanged on disk.
