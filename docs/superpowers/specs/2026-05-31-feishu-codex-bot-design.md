# Feishu Codex Bot Design

Date: 2026-05-31

## Summary

Build a personal Feishu bot that remotely controls Codex running on a local machine or server. The bot uses the official Feishu/Lark server SDK long-connection mode, so the machine running the tool does not need a public webhook URL or Feishu event encryption setup.

The first version is a single-node, multi-project tool:

- One Node.js/TypeScript process runs on the controlled machine.
- The process receives Feishu events through the SDK long connection.
- The process directly starts and manages local `codex` CLI child processes.
- The user can select among allowlisted local project directories.
- Private chat is fully supported; explicitly allowlisted group chats are also supported.
- File persistence is used instead of SQLite.

Multi-node routing is not in scope for the first version. The data model may include `nodeId` for future compatibility, but the product promise is one running bot agent per configured machine.

## Goals

- Control local or server-side Codex sessions from Feishu.
- Avoid requiring public inbound networking for the controlled machine.
- Keep deployment simple enough for old or minimal servers.
- Support multiple allowlisted project directories on the same machine.
- Provide a safe interaction model using user, chat, and project allowlists.
- Persist enough state and logs to understand what happened after restart.
- Avoid Feishu spam for long Codex output.

## Non-Goals

- No hosted control plane in the first version.
- No multi-machine routing in the first version.
- No team-scale tenant model, billing, or organization administration.
- No SQLite/Postgres dependency in the first version.
- No guarantee of recovering a live Codex child process after the bot process restarts.
- No Web UI in the first version.

## Architecture

Use a single Node.js/TypeScript process named the Bot Agent. It runs on the local machine or server that has access to the target repositories and the `codex` CLI.

Internal modules:

- `FeishuGateway`: wraps the Feishu SDK long-connection client, receives message/card events, sends messages and cards, and keeps event handlers fast.
- `CommandRouter`: parses slash commands and decides whether a message is a command or normal Codex input.
- `SessionManager`: owns chat context, active sessions, project selection, and session lifecycle.
- `CodexRunner`: starts and manages local `codex` CLI child processes, including stdin/stdout, pty handling, process stop, and output events.
- `ApprovalManager`: creates approval records, sends Feishu interactive cards when available, and supports text fallback.
- `FileStateStore`: persists snapshots, JSONL audit events, and session logs.

Feishu events enter through `FeishuGateway`, are parsed by `CommandRouter`, update state through `SessionManager`, and may be forwarded to `CodexRunner`. `CodexRunner` streams output back through `SessionManager` to `FeishuGateway`, which applies output formatting before replying in Feishu.

Heavy work should not happen directly in the Feishu event callback. The callback should validate and enqueue work quickly, then asynchronous workers handle Codex interaction and message sending.

## Feishu Interaction Model

The bot uses a hybrid model:

- Slash commands manage sessions, projects, state, and approvals.
- Normal text messages are sent to the current Codex session for the current chat context.

Supported chat scopes:

- Private chat with allowlisted users.
- Explicitly allowlisted group chats.

Group chat control still requires the sender to be an allowlisted user. Non-allowlisted users are ignored or receive a configurable no-permission reply.

Initial commands:

- `/help`: show commands and current restrictions.
- `/projects`: list configured project IDs and display names.
- `/use <project>`: set the current project for the chat context.
- `/new [project]`: create a Codex session in the specified or current project.
- `/send <text>`: explicitly send text to the current session.
- `/status`: show current project, current session, running state, recent summary, and pending approvals.
- `/tail [n]`: show the current session's latest output lines, defaulting to 80.
- `/stop`: stop the current Codex task or session after confirmation.
- `/sessions`: list recent sessions for the chat context.
- `/approve <id>`: approve a pending action when card interaction is unavailable.
- `/reject <id>`: reject a pending action when card interaction is unavailable.

If a normal message arrives with no current session, the bot should prompt the user to run `/projects` and `/new`, or choose a default project when one is configured.

## Output Strategy

Use a mixed output strategy:

- Short output is sent directly as Feishu text messages.
- Long output is summarized and represented as a status message or card.
- Final results are summarized.
- Full raw output is written to the local session log.
- `/tail [n]` retrieves recent local log lines.

The formatter should enforce Feishu message size limits and avoid repeatedly sending large streams into the chat.

## Persistence

Use file persistence, not SQLite.

Default state directory:

```text
.code-bot/
  config.json
  state/
    runtime.json
    chats/<chatId>.json
    sessions/<sessionId>.json
    approvals/<approvalId>.json
  events/
    YYYY-MM-DD.jsonl
  logs/
    sessions/<sessionId>.log
```

Responsibilities:

- `config.json`: Feishu app config, allowlisted users, allowlisted group chats, project whitelist, output thresholds, and Codex launch settings.
- `runtime.json`: local node metadata, process start time, and schema version.
- `chats/<chatId>.json`: current project, current session, and chat preferences.
- `sessions/<sessionId>.json`: session metadata, including project, status, pid, creator, last activity, and log path.
- `approvals/<approvalId>.json`: approval status, risk summary, linked session, expiration, requester, and approver.
- `events/YYYY-MM-DD.jsonl`: append-only audit events for messages, commands, session changes, approvals, and errors.
- `logs/sessions/<sessionId>.log`: raw Codex output.

Write rules:

- Snapshot JSON files are written using temporary files followed by atomic rename.
- JSONL event files are append-only.
- All writes inside one bot process go through a serialized write queue.
- Startup validates schema version and reloads snapshots.
- Damaged JSONL tail lines are ignored during recovery.
- Multiple bot processes must not share the same state directory.

This design accepts weaker ad hoc querying than SQLite. It mitigates that weakness by keeping current state in snapshot files and only using JSONL for audit history.

## Project Model

The first version supports a single node with multiple configured projects.

Each project has:

- `projectId`
- display name
- absolute path
- optional default Codex launch arguments

Users select projects by ID, not by arbitrary filesystem path. Before starting Codex, the runner resolves the working directory and verifies that it is exactly one of the allowlisted project paths or safely inside an allowlisted root when that mode is explicitly configured.

## Security Model

The first version uses layered allowlists:

- Feishu user allowlist.
- Feishu group chat allowlist.
- Project directory allowlist.
- Approval for risky bot-level operations.

Bot-level operations requiring confirmation:

- `/stop`
- switching away from a running session
- deleting or cleaning history; deletion commands are deferred, but any future destructive history command must use the same approval path
- future cross-project operations

Approval behavior:

- Prefer Feishu interactive cards.
- Include session ID, project, requester, risk summary, and expiration.
- Fall back to `/approve <id>` and `/reject <id>` when card events are unavailable.
- Persist all approvals in snapshot files and audit logs.

Codex-internal command approval depends on what the `codex` CLI exposes through its terminal interaction. `CodexRunner` should detect recognizable confirmation prompts and convert them into Feishu approvals when feasible. If detection is not reliable, it should relay the prompt text and wait for explicit user input rather than guessing.

Sensitive data handling:

- Do not log Feishu app secrets or tokens.
- Do not include raw Feishu credentials in events.
- Keep Codex output logs local by default because they may contain repository or secret data.

## Error Handling and Recovery

Feishu long connection:

- `FeishuGateway` reconnects when the SDK connection drops.
- Reconnects are recorded as audit events.
- Event callbacks should remain fast and enqueue work.

Codex process failure:

- Mark the session as `exited`.
- Store exit code, end time, and recent output summary.
- Notify the relevant chat.

Bot process restart:

- Reload project, chat, session, approval, and log metadata.
- Mark sessions that were running before restart as `interrupted` or `unknown`.
- Do not claim live Codex child process recovery in the first version.

State file damage:

- Non-critical damaged snapshots are skipped and recorded as errors.
- Critical damage puts the bot into degraded mode.
- Degraded mode allows read-only commands such as `/status`, `/sessions`, and `/tail` where possible.

Missing `codex` CLI:

- Startup health check records the problem.
- The bot can still connect to Feishu.
- `/new` returns a clear error until the CLI is available.

Feishu card failure:

- Fall back to text approval.
- Keep the same approval ID and expiration.

## Testing Strategy

Unit tests:

- command parsing
- permission checks
- chat allowlist behavior
- project path validation
- output chunking and summarization thresholds
- atomic snapshot writes
- JSONL append and recovery from damaged tail lines

Integration tests:

- fake Feishu gateway plus fake Codex process for normal message flow
- session creation and project switching
- approval creation, approval, rejection, and expiration
- Codex process abnormal exit
- state reload after restart

Manual acceptance tests:

- real Feishu long-connection SDK with the configured app
- private chat command flow
- configured group chat command flow
- real `codex` CLI session
- long output behavior
- approval card and text fallback
- process restart and history inspection

No browser UI tests are needed for the first version because there is no Web UI.

## First Implementation Scope

The first implementation should deliver:

- TypeScript project scaffold.
- Feishu long-connection gateway.
- Config loading and validation.
- File state store.
- Command parser and router.
- Single-node multi-project session manager.
- Codex CLI runner behind a `CodexRunner` interface.
- Text message output with chunking and basic summary behavior.
- Approval manager with Feishu interactive card support and text fallback.
- Unit and integration tests using fake Feishu and fake Codex adapters.

Features intentionally deferred:

- hosted control plane
- multi-node routing
- database-backed state store
- Web UI
- full live process recovery after bot restart
- team administration and tenant model
