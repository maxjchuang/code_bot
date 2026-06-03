# Codex Status in `/status` Command Design

## Goal

Extend the existing `/status` command so it includes Codex native `status` information in the same reply, without introducing a separate command and without making `/status` depend entirely on Codex responsiveness.

The command should keep its current local bot/session summary and augment it with Codex status details when available.

## Non-Goals

- Do not add a new `/codex-status` command.
- Do not replace the current local `/status` block with raw Codex output only.
- Do not make `/status` fail just because Codex native status could not be fetched.
- Do not depend on exact long-term stability of Codex terminal wording.
- Do not query ended sessions as if they were still live.

## Problem Statement

The current `/status` implementation only reports bot-local state:

- selected project
- active session id
- local session status
- saved summary
- pending approvals

That is useful but incomplete. A user also wants the kind of information available from Codex native `status`, because it reflects the current Codex-side view of the active task and environment.

Today, the repository already has a structured observation path for Codex session data, but `/status` still does not actively incorporate Codex native `status` output. The result is a gap between:

- what the bot thinks is happening, and
- what Codex itself reports for the active session.

The design should close that gap while preserving the reliability of the current command.

## Selected Approach

Use a mixed strategy:

1. Always render the existing local `/status` block first.
2. If the active session is `running` or `starting`, actively request Codex native `status`.
3. Parse the returned text into a small structured summary and also preserve a cleaned raw appendix.
4. Cache the latest Codex status result on the session so ended sessions can still show the most recent known native status.
5. If live fetch fails, times out, or is unavailable, return the local block anyway and show either cached Codex status or an explicit unavailable marker.

This approach keeps `/status` reliable while still surfacing Codex-native information when it matters.

## User-Facing Behavior

`/status` output should be organized into three sections.

### 1. Local Status

Keep the current fields:

- `Project`
- `Session`
- `Status`
- `Summary`
- `Pending approvals`

This section is always present, even if no Codex session is active or Codex native status cannot be fetched.

### 2. Codex Status Summary

Add a new section derived from Codex native `status` output. This section should display only stable, useful fields that can be parsed conservatively.

Initial target fields:

- `Source`: `live`, `cached`, or `observation_fallback`
- `Fetched at`
- `Status line`
- `Current task`
- `Progress hint`
- `Context window`
- `Token usage`
- `Model`
- `Working directory`

Not all fields are required on every response. Missing fields should simply be omitted rather than rendered as misleading placeholders.

### 3. Codex Raw Status

Append a cleaned raw text block containing the native Codex `status` output that was used for parsing.

Purpose:

- preserve fidelity when the parser misses something
- help debug format drift in Codex output
- support future parser improvements without hiding information from the user

If no raw text is available, this section is omitted.

## Execution Flow

### Active Running Session

When the current session is `running` or `starting`:

1. Read chat and local session state.
2. Assemble the local status block immediately.
3. Send a `status` message into the active Codex session.
4. Wait for a short response window.
5. If Codex status text is obtained, parse it, cache it, and include it in the reply as `Source: live`.
6. If live fetch fails or times out, fall back to cached status if present.
7. If neither live nor cached Codex status is available, append `Codex status: unavailable`.

### Ended or Interrupted Session

When the current session is `exited` or `interrupted`:

- do not send a new `status` message into Codex
- read cached Codex status if available
- render it as `Source: cached`
- otherwise render `Codex status: unavailable`

### No Active Session

If there is no current session:

- return the current local `none` values
- do not attempt any Codex status fetch
- omit Codex raw status

## Data Model

Add a session-level cache for the latest Codex native status result.

Suggested shape:

```ts
type CachedCodexStatus = {
  source: 'live' | 'cached' | 'observation_fallback';
  fetchedAt: string;
  rawText: string;
  summary: {
    statusLine?: string;
    currentTask?: string;
    progressHint?: string;
    contextWindow?: string;
    tokenUsage?: string;
    model?: string;
    cwd?: string;
  };
};
```

Store this under the persisted session record, for example as `session.codexStatus`.

Design constraints:

- `rawText` is the source of truth for what Codex reported.
- `summary` is a convenience projection for stable rendering.
- `fetchedAt` is required so the UI can indicate staleness if needed later.
- `source` should describe the result used for rendering, not the entire historical provenance chain.

## Parsing Strategy

The parser should be conservative and line-oriented.

Rules:

- preserve the full cleaned native text first
- parse only fields with recognizable labels or clear structure
- allow partial extraction without treating it as failure
- never invent values when a field is absent
- if parsing yields no structured fields but raw text exists, keep the raw text and mark the summary as sparse

The parser should prefer resilience over completeness. Codex native `status` wording may evolve, so the safe failure mode is:

- fewer extracted fields
- preserved raw text
- no broken `/status` command

## Observation Fallback

If live native `status` is unavailable and no cached native text exists, the implementation may optionally synthesize a minimal Codex section from structured observation data.

This fallback should stay narrow and clearly labeled as `Source: observation_fallback`.

Allowed fields for this fallback:

- current inferred status
- latest commentary
- latest activity timestamp

This is not a replacement for native `status`. It is only a better-than-nothing intermediate path when the observation layer has useful structured data and native status text is not available.

## Timeouts and Concurrency

`/status` is a read-oriented command and should remain fast.

Constraints:

- use a short live-fetch timeout, on the order of 1 to 3 seconds
- do not allow unbounded waiting for Codex response
- permit only one in-flight live `status` fetch per session
- concurrent `/status` requests for the same session should reuse the same in-flight operation or fall back to cached data

This avoids turning repeated `/status` checks into repeated injected commands that interfere with the active session.

## Integration Boundaries

The feature should be split into clear responsibilities:

- `SessionManager`: orchestrates `/status`, local fields, and fallback decisions
- Codex status fetcher: requests live native `status` from a running session and returns cleaned text
- Codex status parser: converts native text into structured summary fields
- state store/session persistence: saves and loads `session.codexStatus`

This keeps fetching, parsing, persistence, and presentation independently testable.

## Error Handling

Failure cases should degrade explicitly rather than silently:

- live fetch timeout: use cached value if present, otherwise mark unavailable
- live fetch send failure: use cached value if present, otherwise mark unavailable
- parse failure with raw text still available: keep raw text, render sparse or empty summary
- store write failure after a successful fetch: still return the live result for the current reply, but log the persistence failure

The command should only fully fail if the existing local `/status` path itself fails.

## Testing Scope

At minimum, cover:

- running session with successful live Codex `status`
- running session with live Codex timeout
- running session with live fetch failure and cached fallback
- running session with no live result and no cache
- exited session that shows cached Codex status without sending a new request
- no active session
- parser extracting known fields from representative native status text
- parser preserving raw text when structured extraction is partial
- concurrent `/status` requests reusing a single in-flight live fetch
- rendering of `Source: live`, `Source: cached`, and `Source: observation_fallback`

## Open Implementation Notes

This design intentionally leaves two implementation details flexible:

1. Whether the live fetch is satisfied through existing PTY send/tail mechanics or through a tighter session-specific response hook.
2. The exact formatting of the raw status appendix in plain text versus Feishu card rendering.

Those choices should be settled in the implementation plan, but they do not change the command contract defined here.
