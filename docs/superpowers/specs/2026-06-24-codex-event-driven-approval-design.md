# Codex Event-Driven Approval Design

## Goal

Evolve `code_bot` from a PTY-output-centered Codex controller into an event-driven Codex session system with a real Feishu approval loop.

The design borrows the strongest architectural ideas from MioIsland:

- structured agent lifecycle events
- one state mutation path
- explicit session phases
- hook-backed permission requests
- user-facing approval UI that can answer the agent process

The first implementation should keep the existing PTY control plane. Codex is still started, resumed, stopped, and written to through `CodexRunner`. The new architecture adds a unified event layer and optional Codex hooks around that control plane.

## Non-Goals

- Do not remove `PtyCodexRunner`.
- Do not remove `/tail` or `/rawtail`.
- Do not replace Codex CLI with direct API calls.
- Do not silently modify `~/.codex` on startup in the first shipped behavior.
- Do not add Claude Code support in this design.
- Do not implement automatic allow or deny risk policy in the first approval version.
- Do not redesign the global Feishu renderer beyond approval cards and hook-management responses.

## Selected Approach

Use an event-driven architecture with phased rollout.

All meaningful Codex runtime signals should be represented as internal `CodexSessionEvent` values:

- Feishu text commands and normal task messages
- PTY runner start, output, and exit events
- structured Codex observation snapshots from local rollout files
- optional Codex hook events
- Feishu approval card actions
- startup recovery events

These events should flow through one session state update boundary. Side effects, such as sending text to Codex, sending Feishu cards, writing hook responses, or persisting records, happen around that boundary rather than being embedded as scattered state changes.

This keeps the existing bot useful when hooks are not installed, while making hooks and approval a first-class path when they are enabled.

## Architecture

### New Boundaries

Add these conceptual components:

- `CodexEventBus`: serializes internal Codex session events and dispatches them to the state machine.
- `CodexSessionStateMachine`: pure or mostly pure transition logic from current session snapshot plus event to next session snapshot plus requested side effects.
- `CodexHookService`: owns Codex hook installation, hook health checks, local hook listener, and pending permission request response handles.

The exact file names can be chosen during planning, but these responsibilities should remain separate.

### Existing Component Changes

`PtyCodexRunner` remains the control plane. It should still own process lifecycle and PTY input.

`CodexObservationStore` remains the structured read side channel for `~/.codex/sessions/*.jsonl`. Its snapshots should be converted into internal events instead of directly driving user-facing behavior in several places.

`SessionManager` becomes more of a Feishu orchestration layer:

- parse commands and card actions
- check authorization
- call the event bus
- execute approved side effects
- render command responses

`ApprovalManager` should evolve from a reserved command-level approval store into a runtime approval manager that can track Codex permission requests.

## Session Event Model

The event model should be explicit about source and intent.

Suggested event families:

```ts
type CodexSessionEvent =
  | { type: 'user.message_submitted'; chatId: string; userId: string; sessionId: string; text: string; at: string }
  | { type: 'command.new_requested'; chatId: string; userId: string; projectId?: string; at: string }
  | { type: 'command.stop_requested'; chatId: string; userId: string; sessionId: string; at: string }
  | { type: 'runner.started'; sessionId: string; pid?: number; at: string }
  | { type: 'runner.output_received'; sessionId: string; text: string; at: string }
  | { type: 'runner.exited'; sessionId: string; exitCode?: number; at: string }
  | { type: 'observation.snapshot_ready'; sessionId: string; codexSessionId: string; snapshot: unknown; at: string }
  | { type: 'observation.task_started'; sessionId: string; codexSessionId: string; at: string }
  | { type: 'observation.task_completed'; sessionId: string; codexSessionId: string; finalAnswer?: string; at: string }
  | { type: 'hook.session_started'; hookSessionId: string; cwd?: string; at: string }
  | { type: 'hook.user_prompt_submitted'; hookSessionId: string; cwd?: string; at: string }
  | { type: 'hook.stop'; hookSessionId: string; at: string }
  | { type: 'hook.permission_requested'; request: CodexPermissionRequest; at: string }
  | { type: 'approval.requested'; approvalId: string; sessionId: string; at: string }
  | { type: 'approval.approved'; approvalId: string; userId: string; at: string }
  | { type: 'approval.rejected'; approvalId: string; userId: string; reason?: string; at: string }
  | { type: 'approval.expired'; approvalId: string; at: string }
  | { type: 'session.recovered_interrupted'; sessionId: string; at: string }
  | { type: 'session.auto_resumed'; sessionId: string; sourceSessionId: string; at: string };
```

The final implementation can refine payload shapes. The important design point is that every state-changing input has one named event.

## Session Phase Model

Keep the existing `SessionRecord.status` for compatibility:

```ts
type SessionStatus = 'starting' | 'running' | 'exited' | 'interrupted' | 'unknown';
```

Add a more precise phase field:

```ts
type CodexSessionPhase =
  | 'idle'
  | 'starting'
  | 'processing'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'exited';
```

Compatibility rule:

- `status` answers whether the local bot process/session is generally running.
- `phase` answers what the Codex task is currently doing.

This avoids breaking existing commands while giving `/status`, notifications, approval, and recovery a better state vocabulary.

Expected high-level transitions:

- `idle -> starting` when `/new` or `/resume` starts a process.
- `starting -> waiting_for_input` after the runner starts but before a user task.
- `waiting_for_input -> processing` when a normal message is submitted.
- `processing -> waiting_for_approval` when a permission hook arrives.
- `waiting_for_approval -> processing` when the approval is allowed or rejected and Codex continues.
- `processing -> completed` when observation detects task completion.
- `completed -> waiting_for_input` once the completion notification has been sent or a new turn starts.
- any non-terminal phase can become `interrupted`, `failed`, or `exited` from runner exit, stop, or startup recovery.

## Codex Hooks

### Hook Management Mode

Use a mixed hook-management model:

- First shipped behavior is explicit command control.
- The architecture reserves startup health checks and future automatic repair.
- Automatic repair is disabled by default.

Suggested config:

```json
"codexHooks": {
  "enabled": false,
  "autoRepair": false,
  "socketPath": ".code-bot/codex-hooks.sock",
  "permissionTimeoutMs": 300000,
  "adminUsers": []
}
```

Initial command surface:

- `/hook-status`: report Codex hook health.
- `/install-hooks`: install or repair `code_bot` managed Codex hooks.
- `/uninstall-hooks`: remove only `code_bot` managed Codex hooks.

These commands should be admin-only because they modify user-level Codex configuration. Admin authorization should use `codexHooks.adminUsers` when it is non-empty, otherwise fall back to `upgrade.adminUsers`. If neither list has users, hook mutation commands should be unavailable and `/hook-status` should remain readable by normal authorized users.

`enabled` controls whether the bot starts the hook listener and consumes hook events. `/install-hooks` may write files while `enabled=false`, but the installed hooks will only be useful after `enabled=true` and the bot listener is running. This avoids an install command unexpectedly changing runtime behavior without a config change.

`socketPath` is relative to the project root unless it is absolute.

### Installer Rules

The installer may touch:

- `~/.codex/config.toml`
- `~/.codex/hooks.json`
- a `code_bot` hook script under `.code-bot/` or another managed path
- a manifest file recording exactly what `code_bot` installed

The installer must not remove or rewrite unrelated user hooks.

The manifest should record:

- hook command
- hook script path
- install time
- whether the installer enabled a Codex feature flag
- managed event names

Uninstall should only remove entries matching the manifest or the `code_bot` managed marker.

### Hook Listener

The hook script should be small and defensive:

- read Codex hook payload from stdin
- connect to the local listener
- forward the payload as JSON
- for non-permission events, exit quickly
- for permission events, wait up to `permissionTimeoutMs`
- if the listener is unavailable or times out, return no allow or deny decision so Codex can fall back to its native prompt

The local listener belongs to `CodexHookService`. It should convert hook payloads into `CodexSessionEvent` values.

## Feishu Approval Flow

The first approval policy is:

> Feishu first; timeout falls back to Codex native prompt.

Flow:

1. Codex emits a permission hook.
2. The hook script sends the payload to `CodexHookService` and waits.
3. `CodexHookService` creates a pending permission handle and emits `hook.permission_requested`.
4. The event layer creates a pending approval record and emits `approval.requested`.
5. `SessionManager` sends a Feishu approval card.
6. The user clicks Allow or Deny.
7. Feishu card action emits `approval.approved` or `approval.rejected`.
8. `CodexHookService` writes the matching response to the waiting hook request.
9. If no response arrives before timeout, the approval expires and the hook request is released without an allow or deny decision.

### Approval Card Content

The card should show:

- project name
- session id
- tool name
- key tool input fields
- requesting user or chat context when known
- expiration time
- Allow and Deny actions

The first version should not attempt deep risk scoring. It should format the tool input safely and compactly, truncating large values.

### Approval Records

Extend approval persistence with fields needed for permission requests:

- `toolName`
- `toolInput`
- `hookRequestId`
- `expiresAt`
- `resolvedBy`
- `resolvedAt`
- `resolution`
- optional `failureReason`

Existing `/approve <id>` and `/reject <id>` can remain as text fallbacks, but Feishu card actions should be the primary UX.

## Persistence and Recovery

### Session Records

Add optional session fields:

- `phase`
- `codexHookSessionId`
- `codexTranscriptPath`
- `lastActivityAt`
- `lastPhaseChangedAt`

Keep existing fields intact.

### Event Log

Continue using the append-only bot event store, but normalize event names around the new event model. This gives operators a clear audit trail for:

- hook installation
- hook health failures
- permission requested
- approval sent
- approval resolved
- approval expired
- hook response sent

### Startup Recovery

On bot restart:

- currently running sessions continue through existing interrupted/auto-resume behavior
- pending approvals are marked expired or interrupted
- waiting hook sockets cannot be recovered
- if hooks are enabled, listener health is checked
- if `autoRepair` is false, startup does not modify `~/.codex`

## Error Handling and Fallbacks

Hooks are optional. If hook support fails, existing PTY and observation behavior should continue.

Fallback cases:

- Hooks not installed: `/new`, `/send`, `/status`, `/tail`, notifications, and recovery continue as today.
- Hook script cannot connect to listener: script exits without a decision and Codex falls back to native behavior.
- Listener receives malformed JSON: log `hook.parse_failed`, do not affect active sessions.
- Feishu approval card send fails: mark approval as `failed_to_notify`; let hook timeout fall back.
- User does not respond: mark approval as expired; release hook without allow or deny.
- User responds after expiration: return a clear Feishu message that the approval is no longer active.
- Codex hook format changes: `/hook-status` should report the mismatch where detectable.

No fallback path should silently allow a permission request.

## User Experience

### Hook Commands

`/hook-status` should return a concise report:

- configured: yes or no
- listener running: yes or no
- config.toml feature enabled: yes or no
- hooks.json contains managed hooks: yes or no
- manifest valid: yes or no
- recommended next command

`/install-hooks` should confirm what it changed:

- hook script written
- hooks.json updated
- config.toml updated if needed
- manifest written

`/uninstall-hooks` should confirm what it removed and whether unrelated hooks remain.

### Approval UX

The approval card should be the primary user path. Text fallback should still work:

```text
Approval required: <toolName>
Session: <sessionId>
Project: <project>
Expires: <timestamp>
Approve: /approve <id>
Reject: /reject <id>
```

Completion notifications and `/status` should reflect `waiting_for_approval` when an approval is pending.

## Testing Strategy

### Unit Tests

State machine:

- phase transitions for runner, observation, hooks, and approval events
- invalid transitions do not corrupt session records
- status and phase compatibility rules

Hook installer:

- install into empty Codex config
- preserve unrelated hooks
- update existing managed hook idempotently
- uninstall only managed entries
- handle invalid `hooks.json` without partial writes

Hook listener:

- ordinary event is accepted and acknowledged
- permission request waits for decision
- allow writes allow response
- deny writes deny response
- timeout releases request without allow or deny
- malformed payload is rejected and logged

Approval manager:

- create permission approval
- resolve once only
- reject cross-chat resolution
- expire pending approval
- late resolution returns a useful error

### Integration Tests

- `/install-hooks` followed by `/hook-status` reports healthy fixtures.
- hook permission request sends a Feishu approval card.
- Feishu Allow action writes an allow response to the hook request.
- Feishu Deny action writes a deny response to the hook request.
- timeout produces expired approval and no allow/deny response.
- existing `/new`, `/send`, `/status`, `/tail`, `/rawtail`, notifications, and startup recovery continue to pass without hooks installed.

## Rollout Plan

### Phase 1: Event and Phase Foundation

Add the internal event model, phase field, and state transition boundary. Convert existing runner and observation signals to events. Do not install or consume Codex hooks yet.

Success criteria:

- existing command behavior remains unchanged
- `/status` can show phase when present
- tests prove phase transitions without hook dependencies

### Phase 2: Hook Management and Non-Permission Events

Add `/hook-status`, `/install-hooks`, `/uninstall-hooks`, the hook manifest, the hook script, and the local listener. Initially consume only lifecycle-style hook events such as session start, prompt submitted, and stop.

Success criteria:

- hooks can be installed and removed safely
- hook events appear in the event log
- bot behavior remains correct when listener is unavailable

### Phase 3: Feishu Permission Approval

Consume permission hooks and add Feishu approval cards. Support allow, deny, expiration, and text fallback commands.

Success criteria:

- a permission hook can be approved from Feishu and Codex receives allow
- a permission hook can be rejected from Feishu and Codex receives deny
- timeout falls back to Codex native prompt
- no failed path silently allows permission

### Phase 4: Health Check and Optional Auto Repair

Add startup health check reporting. Keep `autoRepair` disabled by default, but support it when explicitly configured.

Success criteria:

- startup can report hook drift
- explicit `autoRepair=true` can repair managed hooks without touching unrelated hooks

## Open Decisions Captured

- The selected scope is the full event-driven approval loop.
- Approval default is Feishu first with timeout fallback to Codex native prompt.
- Hook management uses the mixed model, but first shipped behavior is explicit command control.
- Hook management commands should be admin-only because they modify global Codex user configuration.
