# Feishu Codex Bot

Local Feishu long-connection bot for controlling Codex CLI sessions in allowlisted project directories. The bot receives slash commands from Feishu, starts local Codex processes through a PTY, persists session state under `.code-bot/`, and returns status or log tails back to the chat.

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
- Add allowed Feishu user open IDs to `allowedUsers`.
- Add allowed chat IDs to `allowedChatIds`; leave it empty only if private-chat/user allowlisting is enough for your use case.
- Replace project entries with your local repositories. Use absolute paths for clarity.
- Keep `output.directMaxChars` and `output.chunkSize` as reserved config schema fields; current Feishu replies do not enforce these limits.
- Keep `codex.command` as `codex` when the CLI is on `PATH`, or set it to an absolute executable path.
- Use `codex.defaultArgs` for arguments shared by all sessions, and `projects[].codexArgs` for project-specific Codex arguments.
- If Codex CLI is missing when the bot starts, the Feishu gateway still connects. Starting a session with `/new` will report the Codex start failure in chat.

Start the bot:

```bash
npm run dev
```

The bot reads `.code-bot/config.json` from the repository root and writes local state, events, and session logs under `.code-bot/`.

## First Commands

In an allowed Feishu chat:

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
/approve <id>
/reject <id>
```

Notes:

- `/use <project>` selects a project without starting Codex.
- `/new [project]` starts a Codex session for the named project, or for the currently selected project.
- `/tail [n]` returns the last `n` readable log lines from the active session after removing terminal control sequences and TUI redraw noise; default is 80.
- `/rawtail [n]` returns the last `n` raw PTY log lines for debugging; default is 80.
- `/stop` creates a stop approval. Finish it with `/approve <id>` or `/reject <id>`.

## Build And Test

```bash
npm test
npm run build
```
