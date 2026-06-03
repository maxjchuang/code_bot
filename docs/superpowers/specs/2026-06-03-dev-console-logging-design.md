# Dev Console Logging Design

## Goal

Improve `npm run dev` console output so it is useful during day-to-day development without replacing the existing `.code-bot/events/*.jsonl` and error log files.

The console should answer:

- Is the bot up and healthy?
- What chat/session activity is happening right now?
- Did something fail that needs attention?

Detailed diagnostics should remain available behind `LOG_LEVEL=debug`.

## Non-Goals

- Replacing the existing event store or error logs
- Building a live TUI or dashboard
- Printing raw PTY/session output to the console
- Refactoring all observability/event code in one pass

## Configuration

Add environment-variable based console logging control:

- `LOG_LEVEL=error | info | debug`
- Default: `info`

Behavior:

- `error`: only error-level operational failures
- `info`: concise lifecycle and request summaries
- `debug`: `info` plus additional diagnostic context

No `trace` level is needed in this phase.

## Architecture

Introduce a thin shared logger module, e.g. `src/logging/AppLogger.ts`.

Responsibilities:

- Parse `LOG_LEVEL`
- Decide whether a message should be emitted
- Render stable, compact console lines
- Provide a single call surface for the app

Suggested API:

- `createAppLogger(options?)`
- `logger.error(event, fields)`
- `logger.info(event, fields)`
- `logger.debug(event, fields)`

The logger is for console output only. It does not replace event persistence.

## Output Format

Use compact single-line logs optimized for scanning:

```text
[2026-06-03 12:34:56] INFO  startup.ready projects=3 verbosity=normal
[2026-06-03 12:35:01] INFO  inbound.received chat=oc_1 type=private text="inspect status"
[2026-06-03 12:35:02] ERROR session.send_failed chat=oc_1 session=sess_xxx reason="transport down"
```

Rules:

- fixed timestamp prefix
- fixed uppercase level token
- short event name
- flat `key=value` fields
- long text fields truncated

This is intentionally not JSON output.

## Logging Scope

### `info` Level

Default developer output should include:

- `startup.ready`
- `startup.health_check_failed`
- `gateway.started`
- `inbound.received`
- `outbound.replied`
- `session.created`
- `session.resumed`
- `session.auto_resumed`
- `session.auto_started_single_project`
- `session.stopped`
- `session.exited`
- `session.send_failed`
- `notification.sent`
- `notification.failed`

These are the high-signal lifecycle and failure events a developer needs while running `npm run dev`.

### `debug` Level

Debug mode should include `info` output plus diagnostic details such as:

- send-confirmation retries and outcomes
- observation availability/result summaries
- single-project auto-start trigger reasons
- Feishu card-to-text fallback
- session discovery retry/failure context
- notification extraction/completion summaries

Debug mode is for explaining *why* the bot behaved a certain way, not for dumping raw PTY output.

### `error` Level

Always print operational failures, including:

- health check failure
- Feishu incoming processing failure
- message send failure
- session start/send/stop failure
- notification send failure
- background persistence failures that would otherwise be invisible

## Integration Points

Phase 1 should wire the logger into three files only:

### `src/index.ts`

Use for:

- startup summary
- health check result
- inbound message summary
- outbound reply summary

### `src/feishu/FeishuGateway.ts`

Use for:

- gateway startup
- send failure
- card fallback to text
- incoming message processing errors

### `src/session/SessionManager.ts`

Use for:

- session created/resumed/stopped/exited
- single-project auto-start
- send failures
- completion notification sent/failed

This keeps the first pass focused and avoids turning every persisted event into a console log.

## Relation to Persisted Events

The persisted `.code-bot/events/*.jsonl` and `.code-bot/logs/errors/*.jsonl` remain the source of full historical truth.

The new console logger is a summary layer for developers.

The intended split is:

- console: immediate human-readable operational view
- jsonl logs: audit trail and post-hoc debugging

## Testing Strategy

Test the logger behavior and high-value integrations, not every literal console line in the codebase.

Required coverage:

- `LOG_LEVEL=info` prints summary events
- `LOG_LEVEL=error` suppresses info/debug logs
- `LOG_LEVEL=debug` includes extra diagnostic logs
- long preview fields are truncated
- integration points emit expected categories of events
- existing bot behavior is unchanged aside from console output

## Rollout

Phase 1 only:

- introduce `LOG_LEVEL`
- add shared logger
- integrate `index.ts`, `FeishuGateway.ts`, and `SessionManager.ts`
- preserve existing event persistence

Future phases, if needed:

- extend logging to more components
- add structured JSON console mode
- add richer dev-time summaries or a status view
