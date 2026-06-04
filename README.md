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
- Set `logLevel` to `error`, `info`, or `debug` to control bot logging from config. `LOG_LEVEL` still overrides it when you need a temporary runtime override.
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
/model [model] [reasoning]
/tail [n]
/rawtail [n]
/stop
/sessions
/resume <session> [project]
/approve <id>
/reject <id>
/upgrade
```

Notes:

- `/projects` now prefers an interactive Feishu project selector card when projects are configured. `/use <project>` remains the direct text fallback and still selects a project without starting Codex.
- `/new [project]` starts a new Codex session for the named project, or for the currently selected project. If the chat already has a running session, the bot stops it first and then starts the new one. The bot will try to capture the Codex native session ID so the session can be resumed later.
- `/status` returns the local bot/session summary and a Codex-native status block. For running sessions it asks Codex for a fresh `status`; if that is unavailable, it falls back to the most recent cached Codex status or marks it unavailable.
- `/model` now prefers an interactive Feishu card with a model selector and, when all listed models share compatible reasoning levels, a reasoning selector. `/model <model> [reasoning]` remains the direct text fallback. In both forms, it saves chat/project defaults and switches the running session when one is active. Saved selections override project model args for future `/new` and `/resume` commands.
- On bot restart, the last running session for each chat is marked interrupted and automatically resumed when a Codex native session ID was captured.
- `/sessions` lists recent sessions. Session status is shown as `current`, `resumable`, or `not-resumable`.
- `/resume <session> [project]` resumes a Codex session. Prefer the code_bot session ID shown by `/sessions`. Codex native session IDs are also supported, but you must specify `project` or already have a current project selected in the chat.
- `/tail [n]` returns a readable progress summary for the active Codex session. It still accepts and validates an optional count with a default of 80, but that count applies to the sanitized PTY fallback path. When structured Codex observation data is available, `/tail` returns the structured summary instead.
- `/rawtail [n]` returns raw PTY terminal output for exact debugging. It accepts an optional count and defaults to 80.
- `/stop` stops the current session immediately.
- `/approve <id>` and `/reject <id>` are reserved for future approval-gated actions.
- `/upgrade` lets an admin user install the latest configured branch and restart the bot through pm2. See Self Upgrade below.
- Resume limits: old sessions without a captured Codex native ID cannot be resumed by code_bot session ID; stop the active session before resuming another one; when you pass an explicit `project`, it must match the session history.

## Self Upgrade

`/upgrade` lets an admin user pull the latest configured branch, install dependencies, build, and restart the bot through pm2.

Config:

```json
"upgrade": {
  "enabled": true,
  "adminUsers": ["ou_admin_open_id"],
  "pm2ProcessName": "code-bot",
  "remote": "origin",
  "branch": "main"
}
```

Run the bot under pm2:

```bash
npm run build
pm2 start dist/index.js --name code-bot
```

The command refuses to run on a dirty worktree and uses fast-forward-only git updates.

## Build And Test

```bash
npm test
npm run build
```
