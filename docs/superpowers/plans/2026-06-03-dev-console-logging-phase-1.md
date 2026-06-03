# Dev Console Logging Phase 1 Plan

## Objective

Implement a developer-friendly console logging layer for `npm run dev` with `LOG_LEVEL=error|info|debug`, while keeping existing `.code-bot` persisted event/error logs unchanged.

## Scope

Included:

- shared console logger module
- environment-driven log level parsing
- integration in `src/index.ts`
- integration in `src/feishu/FeishuGateway.ts`
- integration in `src/session/SessionManager.ts`
- tests for logger behavior and key integration points

Excluded:

- TUI/dashboard output
- PTY/raw terminal output streaming to console
- persisted event schema changes
- broad observability refactors outside the three target files

## Implementation Steps

### Task 1: Add logger module

Create `src/logging/AppLogger.ts` with:

- log level parsing from `LOG_LEVEL`
- level filtering
- stable line formatting
- truncation for long text fields
- a default console-backed implementation

Add focused unit tests for:

- level filtering
- default level behavior
- field rendering
- truncation

### Task 2: Wire startup and request summaries in `index.ts`

Add console summaries for:

- startup ready
- health check failure
- inbound received
- outbound replied

Keep existing persisted event/error recording behavior unchanged.

Add or update tests around bootstrap behavior as needed.

### Task 3: Wire Feishu operational logs

Integrate the logger into `src/feishu/FeishuGateway.ts` for:

- gateway started
- incoming processing failures
- send failures
- card fallback to text

Prefer concise `info` summaries and richer `debug` diagnostics.

Add/update focused gateway tests.

### Task 4: Wire session lifecycle logs

Integrate the logger into `src/session/SessionManager.ts` for:

- session created/resumed/stopped/exited
- auto-start single-project fallback
- send failures
- completion notification sent/failed

Avoid logging every low-level persisted event; stay on lifecycle summaries.

Add/update focused session tests.

### Task 5: Verification and cleanup

Run:

- logger unit tests
- affected integration tests
- `npm run build`

Check that:

- default `npm run dev` would stay concise
- `LOG_LEVEL=debug` adds more diagnostics
- no existing runtime behavior changed beyond console output

## Risks

### Over-logging in `info`

Risk:

- default console still becomes noisy

Mitigation:

- keep `info` limited to startup, request summaries, lifecycle, and failures

### Inconsistent field formatting

Risk:

- logs become hard to scan if each caller formats differently

Mitigation:

- centralize formatting in the logger module

### Test fragility

Risk:

- tests overfit exact rendered strings

Mitigation:

- assert event categories and critical fields, not every byte of formatting

## Validation Criteria

Phase 1 is complete when:

- `LOG_LEVEL` controls console verbosity
- default `info` output is concise and operationally useful
- `debug` reveals extra diagnostics
- affected tests pass
- build passes
