# Feishu Codex Bot

Local Feishu long-connection bot for controlling Codex CLI sessions in configured project directories. The bot receives slash commands from Feishu, starts local Codex processes through a PTY, persists session state under `.code-bot/`, and returns status or log tails back to the chat.

## Setup

Requirements:

- Node.js 20+
- Codex CLI installed and available on `PATH` to start sessions
- A Feishu/Lark app with bot capability enabled and SDK long-connection credentials

Feishu app setup:

- Enable bot capability for the app.
- Use SDK long-connection/WebSocket event handling; no public callback URL is needed for this mode.
- Subscribe to the `im.message.receive_v1` event.
- Grant the bot message receive/send permissions required by Feishu for this event and replies.
- Add the bot to group chats before using group commands.

Run:

```bash
npm install
mkdir -p .code-bot
cp config.example.json .code-bot/config.json
```

Edit `.code-bot/config.json`:

- Set `feishu.appId` and `feishu.appSecret`.
- Set `restrictUsers` to `true` only when you want to limit allowed Feishu user open IDs, then fill `allowedUsers`.
- Set `restrictChatIds` to `true` only when you want to limit allowed group chat IDs, then fill `allowedChatIds`.
- With either switch left as `false`, that dimension is unrestricted.
- Replace project entries with your local repositories. Use absolute paths for clarity.
- Keep `output.directMaxChars` and `output.chunkSize` as reserved config schema fields; current Feishu replies do not enforce these limits.
- Keep `codex.command` as `codex` when the CLI is on `PATH`, or set it to an absolute executable path.
- Use `codex.defaultArgs` for arguments shared by all sessions, and `projects[].codexArgs` for project-specific Codex arguments.
- When Codex is authenticated with a ChatGPT account, model availability can differ from API usage. In this repository, `gpt-5.4` is verified to work, while `gpt-5.4-medium` returns a Codex CLI `400 invalid_request_error`. If model support is unclear, omit `--model` and let Codex use its default account-compatible model.
- Configure `notifications.enabled`, `notifications.idleMs`, and `notifications.maxFinalChars` to control proactive completion messages. Notifications are enabled by default. `notifications.failureTailChars` is reserved config for failure diagnostics.
- If Codex CLI is missing when the bot starts, the Feishu gateway still connects. Starting a session with `/new` will report the Codex start failure in chat.

Start the bot:

```bash
npm run dev
```

The bot reads `.code-bot/config.json` from the repository root and writes local state, events, and session logs under `.code-bot/`.

## First Commands

In Feishu chat:

```text
/projects
/new <project>
/status
/tail 80
```

After `/new <project>`, plain text messages are sent to the active Codex session. You can also send explicit input with:

```text
/send <text>
```

With completion notifications enabled, plain text messages receive an immediate acknowledgement, then the bot sends a second Feishu message when Codex's final answer is detected. Use `/tail` or `/rawtail` to inspect process output while a task is running.

## Command Reference

```text
/help
/projects
/use <project>
/new [project]
/send <text>
/status
/tail [n]
/rawtail [n]
/stop
/sessions
/resume <session> [project]
/approve <id>
/reject <id>
```

Notes:

- `/use <project>` selects a project without starting Codex.
- `/new [project]` starts a new Codex session for the named project, or for the currently selected project. The bot will try to capture the Codex native session ID so the session can be resumed later.
- On bot restart, the last running session for each chat is marked interrupted and automatically resumed when a Codex native session ID was captured.
- `/sessions` lists recent sessions. Session status is shown as `current`, `resumable`, or `not-resumable`.
- `/resume <session> [project]` resumes a Codex session. Prefer the code_bot session ID shown by `/sessions`. Codex native session IDs are also supported, but you must specify `project` or already have a current project selected in the chat.
- `/tail [n]` returns a readable progress summary for the active Codex session. It prefers structured Codex observation data and falls back to sanitized PTY output when structured observation is unavailable.
- `/rawtail [n]` returns raw PTY terminal output for exact debugging.
- `/stop` stops the current session immediately.
- `/approve <id>` and `/reject <id>` are reserved for future approval-gated actions.
- Resume limits: old sessions without a captured Codex native ID cannot be resumed by code_bot session ID; stop the active session before resuming another one; when you pass an explicit `project`, it must match the session history.

## Build And Test

```bash
npm test
npm run build
```
