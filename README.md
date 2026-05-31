# Feishu Codex Bot

Local Feishu long-connection bot for controlling Codex CLI sessions in allowlisted project directories. The bot receives slash commands from Feishu, starts local Codex processes through a PTY, persists session state under `.code-bot/`, and returns status or log tails back to the chat.

## Setup

Requirements:

- Node.js 20+
- Codex CLI installed and available on `PATH`
- A Feishu/Lark app with long-connection bot credentials

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
- Adjust `output.directMaxChars` and `output.chunkSize` if Feishu message size limits require smaller chunks.
- Keep `codex.command` as `codex` when the CLI is on `PATH`, or set it to an absolute executable path.
- Use `codex.defaultArgs` for arguments shared by all sessions, and `projects[].codexArgs` for project-specific Codex arguments.

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
/stop
/sessions
/approve <id>
/reject <id>
```

Notes:

- `/use <project>` selects a project without starting Codex.
- `/new [project]` starts a Codex session for the named project, or for the currently selected project.
- `/tail [n]` returns the last `n` log lines from the active session; default is 80.
- `/stop` creates a stop approval. Finish it with `/approve <id>` or `/reject <id>`.

## Build And Test

```bash
npm test
npm run build
```
