# Resume Session Card Design

## Goal

Add an interactive Feishu card for resuming Codex sessions.

Users should be able to run `/resume` with no arguments, or click the bot floating menu resume entry, then choose a resumable session from a dropdown. The dropdown must only show sessions from the current chat's currently selected project.

## Non-Goals

- Do not change `/resume <session> [project]` direct command semantics.
- Do not show sessions from other projects in the resume card.
- Do not add project selection to the resume card.
- Do not change the current bot menu private-chat caching behavior.
- Do not allow arbitrary Codex native ids through the card. Native ids remain supported only through the text command.

## Current Context

The bot already supports:

- `/resume <session> [project]` for direct text resume.
- `SessionRecord.projectId` and `SessionRecord.codexSessionId`.
- Feishu interactive cards for model and project selection.
- Card action routing through `SessionManager.handleCardAction`.
- Bot floating menu events mapped to synthetic text commands in `BOT_MENU_COMMANDS`.

The new feature should follow the existing card selector pattern and reuse the existing resume behavior rather than creating a separate session lifecycle.

## User-Facing Behavior

### `/resume <session> [project]`

The existing direct command behavior remains unchanged.

### `/resume`

With no arguments, `/resume` returns a resume selector card when possible.

If no project is selected for the chat, reply:

```text
Choose a project with /projects or /use <project> before resuming a session.
```

If the current session is `running` or `starting`, reply with the existing active-session guard:

```text
Current session <id> is still running. Run /stop before resuming another session.
```

If the current project has no resumable sessions for this chat, reply:

```text
No resumable sessions for project <project>. Run /new <project> to start one.
```

Otherwise return an interactive card.

### Resume Card

The card shows:

- Current project id.
- A session dropdown containing only sessions where:
  - `session.chatId` matches the current chat.
  - `session.projectId` matches the chat's current project.
  - `session.codexSessionId` is present.
- A confirm button.

Session option labels should be compact and identifiable, for example:

```text
sess_abc | exited | 2026-06-10 15:20
```

The fallback text should list the same project-filtered resumable sessions and tell users they can run `/resume <session>`.

### Card Confirm

Confirming the card submits a new card action kind:

```json
{
  "kind": "resume_select",
  "sessionId": "sess_abc"
}
```

On submit, the bot resumes the selected code_bot session using the same safety checks as text resume, plus project isolation checks.

The handler must reject stale or tampered card actions when:

- The selected session does not exist.
- The selected session does not belong to the current chat.
- The chat has no current project.
- The selected session's `projectId` differs from the chat's current project.
- The selected session has no `codexSessionId`.
- Another session is currently `running` or `starting`.

### Bot Floating Menu

Add `resume: '/resume'` to `BOT_MENU_COMMANDS`.

This makes the floating menu resume entry behave exactly like a user sending `/resume`. It uses the existing bot-menu routing and reply behavior.

## Project Isolation

Project isolation is a hard requirement.

The resume card must never list sessions from another project. The card action handler must not trust the card contents alone; it must re-read current chat and session state before resuming. This protects against stale cards and manually modified payloads.

Direct text `/resume <session> [project]` keeps its existing explicit behavior and validation.

## Architecture

### Card Rendering

Add a focused card builder:

```text
src/feishu/ResumeSessionCard.ts
```

It should mirror `ProjectSelectorCard` and `ModelSelectorCard`:

- Accept typed input.
- Return `{ preferred, fallback }`.
- Produce a Feishu interactive card as preferred output.
- Produce a text fallback.

### Card Action Types

Extend `FeishuCardActions` with:

```ts
export interface ResumeSelectCardAction {
  kind: 'resume_select';
  sessionId: string;
}
```

Update `parseCardActionValue` to read `sessionId` from `form_value.sessionId` first, then from `value.sessionId`.

### SessionManager

Add a helper to build the project-filtered resumable session list, for example:

```ts
private async listResumableSessionsForCurrentProject(chatId: string): Promise<
  | { ok: true; chat: ChatContext; sessions: SessionRecord[] }
  | { ok: false; reply: string }
>
```

Use it for `/resume` with no arguments.

Add a shared resume method that can be called by both:

- `/resume <session> [project]`
- `resume_select` card action

The card action path should pass a project expectation based on `chat.currentProjectId`, so stale card actions cannot cross projects.

### Gateway

Add the bot menu key mapping:

```ts
resume: '/resume'
```

No new gateway event type is needed.

## Error Handling

- Unknown card action kind keeps the existing unsupported action reply.
- Missing or invalid session id returns a clear session-not-found or invalid target message.
- Empty project-filtered list returns a text empty state instead of an empty card.
- Card fallback remains useful when interactive cards cannot be rendered or sent.

## Testing

Add focused tests for:

- `/resume` with no args asks for project when none is selected.
- `/resume` with no args returns a card for current-project resumable sessions.
- The card excludes sessions from other projects in the same chat.
- The card excludes sessions without `codexSessionId`.
- `resume_select` resumes the selected session.
- `resume_select` rejects a session from a different project than the current chat project.
- `resume_select` rejects while another session is active.
- Bot menu key `resume` maps to `/resume`.
- Existing `/resume <session> [project]` behavior remains unchanged.

## Acceptance Criteria

- A user can run `/resume` and choose from a dropdown of resumable sessions for the current project.
- Sessions from other projects are not visible in the dropdown.
- A stale card cannot resume a session from a different project.
- The bot floating menu can trigger the same resume card.
- Existing text resume commands continue to work.
