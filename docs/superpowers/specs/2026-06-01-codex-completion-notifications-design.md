# Codex Completion Notifications Design

## Goal

Make code_bot proactively send a readable Feishu message when a Codex task finishes, while keeping `/tail` and `/rawtail` available for process-level inspection.

The feature should remove the need for users to manually poll Codex output for ordinary task results. The default experience is:

1. User sends a normal task message.
2. Bot immediately acknowledges that the task was accepted.
3. Bot sends a second message only when the final result is available.

## Non-Goals

- Do not remove or weaken `/tail` and `/rawtail`.
- Do not introduce a queue for multiple concurrent tasks in the same session in the first version.
- Do not replace the current PTY-based Codex runner with a separate structured execution mode.
- Do not attempt to perfectly parse every future Codex TUI rendering pattern in the first version.

## User Experience

When a normal task is sent to Codex, reply immediately:

```text
已发送给 Codex，完成后我会主动通知你。
session: sess_xxx
```

When the task completes and a final answer can be extracted, proactively send:

```text
Codex 已完成：<project>

<final answer>
```

If the task ends but no reliable final answer can be extracted, send a failure-style notification:

```text
Codex 任务结束，但未能提取明确最终回答。

原因：<reason>
可使用 /tail <session> 查看最近输出。
```

Command messages such as `/tail`, `/rawtail`, `/status`, `/stop`, `/sessions`, `/new`, `/use`, and `/resume` keep their existing request-response behavior.

## Session Semantics

Each session can have at most one pending notified turn.

When a normal task is sent and no pending turn exists:

1. Record a `pendingTurn`.
2. Send the task text to the Codex PTY process.
3. Return the immediate acknowledgement message.

When a normal task is sent while the session already has a pending turn, reject it:

```text
当前 session 正在执行任务，请等待完成后再发送新任务，或使用 /tail 查看进度。
```

This keeps final-answer ownership deterministic. Queueing can be added later after the completion detector and message attribution are proven stable.

## Pending Turn Model

Add an in-memory pending turn record owned by the session runtime:

```ts
type PendingTurn = {
  id: string;
  sessionId: string;
  chatId: string;
  projectId: string;
  prompt: string;
  startedAt: string;
  outputStartIndex: number;
  notified: boolean;
};
```

The first version does not need to persist `pendingTurn` across process restarts. If code_bot restarts during an active Codex task, users can still inspect the session with `/tail` and resume behavior remains governed by the existing session resume design.

## Completion Detection

Use a hybrid strategy:

1. Primary path: detect that the current turn has produced a stable final answer.
2. Fallback path: if the Codex process exits with a pending turn, attempt one final extraction and notify.

The detector observes output appended after `pendingTurn.outputStartIndex`. It should not depend on raw byte-level PTY frames. Instead, it should operate on sanitized text built from the session log.

Primary completion flow:

1. Sanitize the pending turn output.
2. Extract a final-answer candidate.
3. Ignore output that is only progress, status, spinner, prompt echo, quota, or TUI chrome.
4. If the candidate changes, reset the idle timer.
5. If the candidate remains unchanged for `notifications.idleMs`, mark the turn complete.
6. Send the proactive notification and clear `pendingTurn`.

Fallback completion flow:

1. `CodexRunner.onExit` sees a pending turn.
2. Run final extraction over the latest pending turn output.
3. If extraction succeeds, send the final answer notification.
4. Otherwise send the failure-style notification with a concise reason.
5. Clear `pendingTurn`.

## Final Answer Extraction

Introduce a focused extraction module, for example `FinalAnswerExtractor`, instead of growing `SessionManager` with text-processing rules.

Input:

- Raw session log lines for the pending turn.
- Existing terminal sanitizer output.
- Optional extraction limits.

Output:

```ts
type FinalAnswerExtraction =
  | { kind: 'answer'; text: string }
  | { kind: 'empty'; reason: string }
  | { kind: 'failure'; reason: string; diagnostic?: string };
```

The first version should filter common process lines:

- Codex banner and prompt chrome.
- `• Working` and spinner fragments.
- `Starting MCP servers`.
- MCP startup progress.
- quota and context status lines.
- `Tip:` lines.
- prompt echo lines that repeat the user prompt.
- `Ran <command>` blocks unless the command output is part of the final answer.

It should preserve:

- final natural language answer paragraphs.
- bullet and numbered lists.
- code blocks and command snippets when they appear in the final response.
- explicit failure summaries from Codex.

Successful notifications should contain only the final answer. Failure notifications can include a small diagnostic and a `/tail` hint.

## Notifier Boundary

Current `FeishuGateway.start(onMessage)` is request-response oriented. Add an outbound notification boundary:

```ts
type Notifier = {
  sendText(chatId: string, text: string): Promise<void>;
};
```

`FeishuGateway` already owns `sendText`, so it can satisfy this interface directly.

Recommended dependency flow:

1. `bootstrap` creates `FeishuGateway`.
2. `createApp` receives `notifier`.
3. `SessionManager` receives `notifier` or a small notification service.
4. Completion detection calls the notifier with the `chatId` captured on the pending turn.

Notification destination is always the chat that triggered the task, not the latest chat that used the session.

## Configuration

Add a conservative notification section:

```yaml
notifications:
  enabled: true
  idleMs: 3000
  maxFinalChars: 8000
  failureTailChars: 2000
```

Fields:

- `enabled`: enable proactive completion notifications.
- `idleMs`: how long a final-answer candidate must remain stable.
- `maxFinalChars`: maximum final answer length in Feishu. Longer answers are truncated with a `/tail` hint.
- `failureTailChars`: maximum diagnostic excerpt length for failure-style notifications.

When `notifications.enabled` is `false`, normal task messages keep the previous synchronous behavior.

## Logging and Events

Add structured logs around the notification lifecycle:

- `notification.turn_started`
- `notification.turn_busy_rejected`
- `notification.answer_candidate_updated`
- `notification.turn_completed`
- `notification.turn_exit_fallback`
- `notification.final_extract_failed`
- `notification.send_failed`

Notifier failures should be logged. They should not crash the bot process or corrupt the session state.

## Risks and Mitigations

The main risk is that Codex TUI output is not a stable structured protocol.

Mitigations:

- Keep `/tail` and `/rawtail` as the authoritative process inspection tools.
- Limit the first version to one pending turn per session.
- Use a stable-content idle window rather than a single output pattern.
- Trigger a fallback notification on process exit.
- Keep extraction rules isolated and covered by approval-style fixtures from real TUI samples.
- Make the feature configurable so it can be disabled without removing the code path.

Another risk is duplicate notification if output changes after the idle window.

Mitigations:

- Clear `pendingTurn` immediately after successful notification.
- Treat later output as session log only until the next user task creates a new pending turn.
- Prefer a conservative `idleMs` default.

## Testing Strategy

Use test-driven development.

Unit tests:

- final-answer extraction from noisy Codex TUI output.
- extraction from Chinese final answers.
- MCP warnings are not treated as successful final answers.
- spinner and `Working` fragments do not produce answer candidates.
- prompt echo is filtered.
- long final answers are truncated with a `/tail` hint.

Session manager tests:

- normal task returns immediate acknowledgement.
- pending turn is created with the triggering `chatId`.
- busy session rejects a second normal task.
- `/tail` remains available while a turn is pending.
- idle-stable final answer triggers notifier.
- process exit with pending turn triggers fallback notifier.
- notifier failure is logged and does not throw through the message handler.
- disabling notifications restores the previous behavior.

Integration-style tests:

- simulate PTY output chunks that include TUI redraws followed by a final answer.
- verify exactly one Feishu notification is sent for one turn.
- verify the notification target is the original chat id.

