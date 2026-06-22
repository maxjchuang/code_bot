# Final Answer Format Preservation Design

## Problem

Completion notifications can lose formatting compared with `/current`. Recent logs show Codex structured observation final answers containing blank lines, such as `\n\n`, while code_bot's final notification path sends text with those blank lines removed.

The root cause is that `SessionManager.currentTurnObservationExtraction()` treats structured observation `finalAnswer` as raw terminal text by splitting it into lines and passing it through `extractFinalAnswer()`. That extractor is designed for noisy PTY output. It trims every line and filters empty lines, which is correct for terminal cleanup but wrong for already-structured final answers.

## Goal

Preserve structured Codex final answer formatting in completion notifications.

The fix should preserve:

- paragraph blank lines
- indentation
- Markdown list and code block structure
- existing Feishu markdown rendering behavior

The fix should not weaken PTY fallback cleanup.

## Non-Goals

- Do not make `/current` and completion notifications visually identical. `/current` is a terminal snapshot; completion notifications are final answer messages.
- Do not wrap every final answer in a code block.
- Do not remove PTY noise filtering for sessions that lack structured observation data.
- Do not change the event preview format unless needed for debugging. `candidatePreview` may remain single-line because it is only a compact event preview.

## Design

Add a structured final answer preservation path for observation-sourced answers.

`currentTurnObservationExtraction()` should still:

1. load the Codex observation snapshot
2. verify the snapshot is ready or stale
3. verify the snapshot belongs to the current turn
4. enforce `notifications.maxFinalChars`

After that validation, it should not call `extractFinalAnswer()`. Instead it should call a small formatter for structured final answers.

The formatter should:

- normalize line endings from `\r\n` and `\r` to `\n`
- trim only the outer boundary of the answer
- optionally drop an exact prompt echo if the whole answer begins with the prompt as a standalone line
- apply the same truncation behavior used by final answer extraction
- return empty when the resulting text is blank

PTY extraction should remain unchanged and continue to use `extractFinalAnswer()`.

## Data Flow

Structured observation path:

```text
Codex JSONL final_answer
  -> FileCodexObservationStore.finalAnswer
  -> currentTurnObservationExtraction()
  -> preserveStructuredFinalAnswer()
  -> completionBotMessage()
  -> renderFeishuMessage()
  -> Feishu interactive markdown card
```

PTY fallback path:

```text
PTY log lines
  -> currentTurnPtyExtraction()
  -> extractFinalAnswer()
  -> completionBotMessage()
  -> renderFeishuMessage()
```

This keeps the two data sources separate: structured answers are preserved, terminal logs are cleaned.

## Error Handling

If the structured formatter returns no answer, `currentTurnObservationExtraction()` should return `undefined` so the existing fallback path can try PTY extraction.

If the observation is unavailable, stale parsing fails, or the completed timestamp does not match the pending turn, behavior should remain unchanged.

## Testing

Add focused tests in `tests/session/SessionManager.test.ts`:

- observation-sourced final answer with `\n\n` is sent with the blank line preserved
- observation-sourced final answer with indentation is sent with indentation preserved
- PTY-sourced extraction still removes terminal noise and does not start preserving empty TUI lines

Add a unit test if the formatter is exported from a helper module. Otherwise keep coverage through `SessionManager` tests.

## Acceptance Criteria

- A final answer like `方案 1\n\n**方案 2**` is delivered with the blank line before `**方案 2**`.
- A final answer containing an indented code block keeps its indentation.
- `/current` behavior is unchanged.
- PTY fallback behavior is unchanged.
- Existing completion notification tests still pass.
