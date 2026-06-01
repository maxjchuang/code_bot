# Codex Resume Session Design

## Goal

Add first-class resume support to code_bot by reusing Codex CLI's native `codex resume` capability.

The feature should let Feishu users continue an existing Codex conversation from the bot while keeping code_bot's own session lifecycle, project allowlist, logs, stop flow, and chat ownership model intact.

## Non-Goals

- Do not reconnect to a previous `node-pty` process after the bot restarts. `codex resume` starts a new Codex TUI process and resumes Codex conversation context.
- Do not allow arbitrary filesystem paths. Resume always runs inside a configured allowlisted project.
- Do not support an initial prompt in `/resume` for the first version. Users send the next message after resume succeeds.

## Command Semantics

Add:

```text
/resume <session> [project]
```

`<session>` accepts both:

- code_bot session ids, such as `sess_abc`.
- Codex native session ids or single-token thread names, such as a UUID from Codex.

Thread names containing spaces are not supported by the first version because current command parsing splits on whitespace. Users should resume those sessions by Codex UUID.

Project resolution:

1. If `[project]` is present, use it.
2. Otherwise use the current chat's `currentProjectId`.
3. If neither exists, reply:

```text
Choose a project with /projects and /use <project>, or run /resume <session> <project>.
```

If the current chat already has a `running` or `starting` session, `/resume` refuses:

```text
Current session <id> is still running. Run /stop and approve it before resuming another session.
```

On success, `/resume` creates a new code_bot session record and starts a new PTY process with `codex resume`. The old code_bot session remains historical.

Successful reply:

```text
Resumed Codex session for project <project> as <new_code_bot_session_id>.
```

## Data Model

Extend `SessionRecord`:

```ts
codexSessionId?: string;
resumedFromSessionId?: string;
resumeSource?: 'code_bot' | 'codex';
```

Field meanings:

- `codexSessionId`: Codex's native UUID when known.
- `resumedFromSessionId`: the source code_bot session id when resuming from `sess_*`.
- `resumeSource`: whether the user resumed via a code_bot id or a Codex native id/thread name.

`/new` sessions start with no `codexSessionId`. After Codex starts, code_bot attempts to discover and store the Codex id.

`/resume` sessions store:

- `codexSessionId` immediately when the source is a known code_bot session.
- `resumedFromSessionId` when the source is a known code_bot session.
- `resumeSource: 'code_bot'` or `resumeSource: 'codex'` based on the user input path.

If the user resumes by Codex native id or thread name, code_bot passes that value to Codex. After start, it still attempts to discover the resulting Codex UUID and write it to the new session record.

## `/sessions` Display

Keep `/sessions` compact. Do not print long Codex UUIDs by default.

Suggested display:

```text
sess_x | chatbot | exited | resumable | 2026-...
sess_y | chatbot | running | current | 2026-...
sess_z | chatbot | interrupted | not-resumable | 2026-...
```

Status marker rules:

- `current`: this session is the current chat session.
- `resumable`: session has a `codexSessionId`.
- `not-resumable`: session has no known `codexSessionId`.

## Codex Session Discovery

Introduce a small module, for example `CodexSessionRegistry`, dedicated to reading Codex local session metadata.

Responsibilities:

1. Read `~/.codex/session_index.jsonl` and parse entries with `id`, `thread_name`, and `updated_at`.
2. Scan `~/.codex/sessions/**/*.jsonl`.
3. Extract Codex UUIDs from session file names and, when needed, file contents.
4. Match newly created Codex sessions by project path and creation time window.

Discovery for `/new`:

- Record `startedAt` before spawning Codex.
- After spawn, look for sessions updated after `startedAt`.
- Prefer candidates whose cwd or file contents match the allowlisted project path.
- Bind only when there is a unique best candidate.

Discovery failures:

- Do not fail `/new`.
- Leave `codexSessionId` unset.
- Record `session.codex_id_discovery_failed`.
- Show `not-resumable` in `/sessions`.

Delayed discovery:

- `/new` may schedule discovery in the background after spawn.
- `/sessions` or `/resume sess_xxx` may retry discovery for a session that lacks `codexSessionId`.

This keeps session creation responsive while still allowing resume metadata to be filled later.

## Runner Model

Extend the runner start options with an explicit mode:

```ts
type CodexStartMode =
  | { kind: 'new' }
  | { kind: 'resume'; target: string };
```

New session command:

```bash
codex <defaultArgs> <project.codexArgs>
```

Resume command:

```bash
codex resume <defaultArgs> <project.codexArgs> <target>
```

The argument order keeps Codex global options attached to `resume`, matching `codex resume [OPTIONS] [SESSION_ID]`.

Resumed sessions use the same PTY lifecycle as new sessions:

- same cwd allowlist behavior
- same output log persistence
- same `/send`
- same `/tail` and `/rawtail`
- same `/stop` approval flow

## Error Handling and Security

Authorization:

- `/resume` goes through the existing `isAuthorizedMessage` check.

Project allowlist:

- `[project]` or current project must resolve through existing project config.
- Resume never accepts arbitrary cwd input.

Chat ownership:

- If `<session>` matches a code_bot session id, it must belong to the current chat.
- Otherwise reply:

```text
Unknown session for this chat: <id>
```

Missing Codex id:

- If a code_bot source session lacks `codexSessionId`, retry discovery.
- If still missing, reply:

```text
Session <id> is not resumable yet. Use /rawtail to inspect logs or resume with a Codex session id.
```

Codex native ids:

- Native Codex id/thread name inputs are allowed for authorized users.
- They do not have chat ownership checks because they are explicit user-provided Codex identifiers.
- The safety boundary is authorization plus project allowlist.

Startup failure:

- Create a failed session record with status `exited`.
- Set `lastSummary` to `Failed to resume Codex: <reason>`.
- Do not point the chat at the failed session.
- Reply:

```text
Failed to resume Codex session for project <project>: <reason>
```

Events:

- `session.resume_started`
- `session.resume_failed`
- `session.codex_id_discovered`
- `session.codex_id_discovery_failed`

## Testing Strategy

Use TDD.

Command parsing:

- `/resume sess_1`
- `/resume sess_1 chatbot`
- `/resume 019e... chatbot`
- missing argument returns usage

SessionManager behavior:

- rejects `/resume` when current chat has an active session
- resumes from a code_bot session with `codexSessionId`
- resumes from a Codex native id/thread name
- uses current chat project when no project argument is provided
- asks for project when neither command project nor current project exists
- rejects code_bot session ids from another chat
- returns not-resumable when a source session lacks `codexSessionId`
- does not switch chat current session on resume startup failure

Runner:

- `new` mode preserves existing command construction
- `resume` mode launches `codex resume <args> <target>`
- resumed sessions can receive `send` and `stop` through the new code_bot session id

CodexSessionRegistry:

- parses `session_index.jsonl`
- extracts UUIDs from session paths
- matches a unique candidate by cwd and time window
- returns a failure result when there are zero or multiple candidates

Display:

- `/sessions` includes `current`, `resumable`, or `not-resumable`
- `/help` includes `/resume <session> [project]`

## Acceptance Criteria

- A user can run `/sessions` and identify whether a historical session is resumable.
- A user can run `/resume sess_xxx chatbot` to resume the Codex conversation behind a previous code_bot session.
- A user can run `/resume <codex_uuid_or_thread_name> chatbot` to resume a Codex native session directly.
- The resumed session becomes the chat's current session and supports `/send`, plain messages, `/tail`, `/rawtail`, and `/stop`.
- Active current sessions are protected; users must stop them before resuming another session.
- All resume execution remains constrained to allowlisted projects.
