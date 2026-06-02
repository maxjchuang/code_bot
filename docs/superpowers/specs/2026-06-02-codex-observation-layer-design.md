# Codex Observation Layer Design

## Goal

Stop treating Codex TUI output as the primary user-facing data source while keeping the existing PTY-based Codex CLI runtime.

The new default architecture is:

1. Keep PTY as the control plane for `start`, `resume`, `send`, and `stop`.
2. Add a structured observation layer that reads Codex local state from `~/.codex`.
3. Make user-visible progress, final answers, and task summaries come from the observation layer first.
4. Keep PTY log inspection and terminal sanitization as fallback and debugging paths.

## Non-Goals

- Do not replace Codex CLI with direct API execution in this change.
- Do not remove PTY process management.
- Do not implement a full multi-thread or multi-subagent aggregation model in the first phase.
- Do not treat internal Codex local files as a permanently stable public API.
- Do not remove `/rawtail`.

## Problem Statement

The current design treats PTY output as both:

- the control transport for Codex CLI, and
- the main source of user-visible status and results.

This creates recurring fragility:

- TUI redraws, cursor movement, and terminal control sequences pollute `/tail`.
- final-answer extraction depends on unstable screen text patterns.
- status inference depends on terminal output shape rather than structured task events.
- fixes tend to be heuristic and reactive.

Local Codex state already provides a stronger side channel:

- `~/.codex/sessions/YYYY/MM/DD/*.jsonl` stores structured session events.
- `~/.codex/session_index.jsonl` maps known threads.
- `~/.codex/state_5.sqlite` stores thread metadata such as title, cwd, and recent activity.

The design should move user-visible behavior onto these structured artifacts while preserving PTY control.

## Selected Approach

Split the system into two explicit planes:

- `CodexControl`: owns PTY-based session lifecycle and input transport.
- `CodexObservation`: owns structured reads from Codex local state.

`SessionManager` and notification logic should consume structured observation data first. PTY-derived text remains available only when observation data is missing, delayed, or unparsable.

## Architecture

### Control Plane

The control plane remains PTY-backed and keeps the current operational semantics:

- launch Codex CLI
- resume Codex sessions
- send user text into the active session
- stop the session process

This plane continues to be implemented by the existing `CodexRunner` / `PtyCodexRunner` path.

### Observation Plane

Add a new observation boundary, for example:

```ts
type ObservationAvailability =
  | { kind: 'ready' }
  | { kind: 'not_found' }
  | { kind: 'not_yet_flushed' }
  | { kind: 'stale' }
  | { kind: 'parse_error'; reason: string };

type CodexObservationSnapshot = {
  availability: ObservationAvailability;
  codexSessionId: string;
  cwd?: string;
  title?: string;
  preview?: string;
  cliVersion?: string;
  model?: string;
  status?: 'running' | 'completed' | 'idle' | 'unknown';
  latestCommentary?: string;
  finalAnswer?: string;
  completedAt?: string;
  recentToolEvents: Array<{
    kind: 'tool_call' | 'tool_output';
    toolName?: string;
    summary: string;
    at: string;
  }>;
};

interface CodexObservationStore {
  readSnapshot(input: { codexSessionId: string; cwd?: string }): Promise<CodexObservationSnapshot>;
}
```

Responsibilities:

- locate the correct Codex session/thread
- read and parse `sessions/*.jsonl`
- extract user-visible structured data
- supplement metadata from `session_index.jsonl` and `state_5.sqlite`
- classify freshness and failure modes explicitly

Non-responsibilities:

- do not start or stop PTY processes
- do not mutate Codex local state
- do not mix in terminal sanitization logic

## Data Sources

### Primary Source: `sessions/*.jsonl`

Use session rollout files as the primary observation source.

Relevant events observed locally include:

- `session_meta`
- `turn_context`
- `event_msg.task_started`
- `event_msg.agent_message`
- `response_item.message`
- `response_item.function_call`
- `response_item.function_call_output`
- `event_msg.task_complete`

Preferred extraction rules:

- final answer: `response_item.message` with `phase: "final_answer"`
- final answer fallback: `event_msg.task_complete.last_agent_message`
- progress text: `event_msg.agent_message` with `phase: "commentary"`
- task completion: `event_msg.task_complete`

### Secondary Source: `session_index.jsonl`

Use as a lightweight mapping source for thread discovery and recent-session lookup. This continues the current repository direction and avoids inventing a separate discovery mechanism.

### Secondary Source: `state_5.sqlite`

Use the `threads` table for metadata that improves display and status decisions:

- thread title
- cwd
- preview
- updated timestamp
- cli version
- model

This is especially useful for `/status`, `/sessions`, and future activity views.

### Tertiary Source: PTY Logs

Retain PTY logs only for:

- `/rawtail`
- fallback `/tail`
- fallback final-answer extraction when structured observation is unavailable

This source should no longer be the default user-facing path.

## User-Facing Behavior

### Final Answer

Priority order:

1. `response_item.message` with `phase: "final_answer"`
2. `event_msg.task_complete.last_agent_message`
3. existing PTY-based extractor fallback

The first successful source wins. The fallback path remains necessary because local Codex file formats are not guaranteed stable.

### Status

Primary structured rules:

- if a matching `task_complete` exists for the latest turn, status is `completed`
- if a recent `task_started` exists without a later `task_complete`, status is `running`
- if the thread exists but no active turn can be inferred, status is `idle` or `unknown`

`threads.updated_at_ms` may be used as a supporting signal, not the sole status authority.

### `/tail`

Change `/tail` semantics from terminal tailing to observation summary.

Default `/tail` output should prefer:

- latest commentary message
- recent tool-call summaries
- concise relevant tool output excerpts
- completion summary when available

It should not dump raw structured JSON and should not attempt to mirror a terminal screen.

### `/rawtail`

Keep existing raw PTY inspection behavior for exact terminal debugging.

## Observation Freshness and Failure Modes

The observation layer must distinguish these cases explicitly:

- `ready`: structured data is usable
- `not_found`: no matching local Codex session artifacts were found
- `not_yet_flushed`: the turn likely exists but structured events have not been flushed yet
- `stale`: matching data exists but is too old to trust as current turn output
- `parse_error`: artifacts exist but could not be parsed reliably

This distinction matters because PTY and local artifact writes are not guaranteed to be synchronized.

## Fallback Strategy

### Final Answer

- use structured observation first
- if unavailable, use the current PTY-based final-answer extraction path

### `/tail`

- use observation summary first
- if unavailable, fall back to the current sanitized terminal tail

### `/status`

- use structured observation first
- if unavailable, return a conservative status without inventing progress text

The fallback path is a compatibility mechanism, not a peer architecture. The system should prefer observation whenever it is trustworthy.

## Tool Output Handling

Structured tool output can still be noisy. The observation layer should not expose raw `function_call_output` bodies without limits.

Rules:

- summarize command/tool intent when possible
- truncate long outputs
- preserve short outputs that are directly useful to the user
- avoid rendering command boilerplate when it does not help explain progress

This keeps `/tail` readable without reintroducing a new form of log spam.

## Subagent and Multi-Thread Scope

Codex local state already contains thread-source metadata such as subagent provenance.

However, the first implementation phase should stay narrow:

- observe the current primary Codex thread associated with the active session
- do not build cross-thread aggregation in the first phase
- do not attempt to merge parent/worker timelines into a single user-visible narrative yet

This keeps the first plan focused and reduces misattribution risk.

## Delivery Plan

### Phase 1: Observation for Final Answer and `/tail`

Implement the new observation layer and wire it into:

- final-answer extraction
- proactive completion notifications
- `/tail` observation summary

Keep unchanged:

- `PtyCodexRunner`
- `/rawtail`
- `resume/send/stop`

This phase is the first implementation target because it removes the most fragile TUI dependencies while preserving current control behavior.

### Phase 2: Observation-Backed Session Status and Listing

Expand use of structured observation to:

- `/status`
- `/sessions`
- session display metadata

Use `threads` and `session_index.jsonl` to improve session discovery and presentation without relying on terminal output.

### Phase 3: Shrink Sanitizer Responsibility

Demote terminal sanitization from primary behavior to fallback behavior.

After phases 1 and 2 are stable:

- keep sanitizer for compatibility and debugging
- stop using sanitizer-driven text as the main source for final answers, progress, and status

## Testing

### Observation Parser Tests

Add focused tests for:

- final-answer extraction from structured events
- commentary extraction
- task completion extraction
- missing fields
- malformed JSON lines
- unknown event types

### SessionManager Integration Tests

Add tests for:

- `/tail` uses observation summary when ready
- `/tail` falls back to sanitized PTY output when observation is unavailable
- final-answer notification prefers structured observation
- final-answer extraction falls back when observation fails
- `/status` returns conservative output when observation is unavailable

### Regression Tests

Cover:

- delayed session-file flushes
- stale observation snapshots
- long tool outputs
- no final answer but completed task

## Risks and Mitigations

### Internal Format Drift

Risk:
Codex local files are not guaranteed stable across CLI versions.

Mitigation:

- isolate all local-file parsing behind one adapter
- tolerate unknown event types
- prefer additive parsing rules
- preserve PTY fallback

### Data-Source Skew

Risk:
PTY output and observation files may update at different times.

Mitigation:

- model `not_yet_flushed` and `stale` explicitly
- avoid claiming completion until structured completion signals appear or fallback is required

### User Expectation Shift for `/tail`

Risk:
users may expect `/tail` to mean terminal tail forever.

Mitigation:

- keep `/rawtail` unchanged
- document `/tail` as progress summary rather than raw terminal view

### Over-Verbose Tool Output

Risk:
structured tool outputs can become a second source of unreadable logs.

Mitigation:

- summarize and truncate aggressively
- keep the raw path in `/rawtail`

## Acceptance Criteria

- PTY remains the control plane for Codex CLI sessions.
- Final-answer extraction no longer depends primarily on TUI parsing.
- `/tail` returns a structured observation summary by default.
- `/rawtail` still exposes PTY-derived raw logs.
- Observation failure modes are explicit and covered by tests.
- Terminal sanitization remains available only as a fallback path.
