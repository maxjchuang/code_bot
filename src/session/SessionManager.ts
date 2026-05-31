import type { BotConfig, ChatContext, ChatType, SessionRecord } from '../domain/types.js';
import { parseIncomingText } from '../commands/CommandRouter.js';
import { createCodexSessionId, type CodexRunner } from '../codex/CodexRunner.js';
import { formatTail } from '../output/OutputFormatter.js';
import { FileStateStore } from '../state/FileStateStore.js';
import { isAuthorizedMessage, resolveProject } from '../security/guards.js';

export interface IncomingBotText {
  chatId: string;
  chatType: ChatType;
  userId: string;
  text: string;
}

export interface BotTextResult {
  reply: string;
}

export class SessionManager {
  constructor(
    private readonly config: BotConfig,
    private readonly store: FileStateStore,
    private readonly runner: CodexRunner,
  ) {}

  async handleText(input: IncomingBotText): Promise<BotTextResult> {
    if (!isAuthorizedMessage(this.config, input)) {
      return { reply: 'You are not allowed to control this bot.' };
    }

    const parsed = parseIncomingText(input.text);
    if (parsed.kind === 'message') {
      return this.sendToCurrentSession(input.chatId, parsed.text);
    }

    switch (parsed.name) {
      case 'help':
        return {
          reply:
            '/projects\n/use <project>\n/new [project]\n/send <text>\n/status\n/tail [n]\n/stop\n/sessions\n/approve <id>\n/reject <id>',
        };
      case 'projects':
        return { reply: this.config.projects.map((project) => `${project.id}: ${project.name}`).join('\n') };
      case 'use':
        return this.useProject(input, parsed.args[0]);
      case 'new':
        return this.createSession(input, parsed.args[0]);
      case 'send':
        return this.sendToCurrentSession(input.chatId, parsed.args[0] ?? '');
      case 'status':
        return this.status(input.chatId);
      case 'tail':
        return this.tail(input.chatId, parsed.args[0]);
      default:
        return { reply: `Unknown command: /${parsed.name}` };
    }
  }

  private async useProject(input: IncomingBotText, projectId?: string): Promise<BotTextResult> {
    if (!projectId || !resolveProject(this.config, projectId)) {
      return { reply: `Unknown project: ${projectId ?? ''}`.trim() };
    }
    const existing = await this.store.getChat(input.chatId);
    await this.store.saveChat({
      chatId: input.chatId,
      chatType: input.chatType,
      currentProjectId: projectId,
      currentSessionId: existing?.currentSessionId,
    });
    return { reply: `Current project set to ${projectId}.` };
  }

  private async createSession(input: IncomingBotText, projectId?: string): Promise<BotTextResult> {
    const previousChat = await this.store.getChat(input.chatId);
    const selectedProjectId = projectId ?? previousChat?.currentProjectId;
    if (!selectedProjectId) {
      return { reply: 'Choose a project with /projects and /new <project>.' };
    }
    const project = resolveProject(this.config, selectedProjectId);
    if (!project) {
      return { reply: `Unknown project: ${selectedProjectId}` };
    }

    const now = new Date().toISOString();
    const sessionId = createCodexSessionId();
    const session: SessionRecord = {
      id: sessionId,
      chatId: input.chatId,
      projectId: project.id,
      status: 'running',
      createdBy: input.userId,
      createdAt: now,
      updatedAt: now,
      logPath: this.store.sessionLogPath(sessionId),
    };
    await this.store.saveSession(session);
    try {
      await this.runner.start({
        sessionId,
        cwd: project.path,
        args: project.codexArgs,
        onOutput: (text) => {
          return this.appendSessionOutput(sessionId, text).catch((error) =>
            this.recordBackgroundError('session.output_persist_failed', error, { sessionId }),
          );
        },
        onExit: (exitCode) => {
          return this.markExited(sessionId, exitCode).catch((error) =>
            this.recordBackgroundError('session.exit_persist_failed', error, { sessionId, exitCode }),
          );
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      await this.store.saveSession({
        ...session,
        status: 'exited',
        lastSummary: `Failed to start Codex: ${message}`,
        updatedAt: failedAt,
      });
      await this.store.appendEvent({
        type: 'session.start_failed',
        at: failedAt,
        data: { sessionId, projectId: project.id, chatId: input.chatId, reason: message },
      });
      return { reply: `Failed to start Codex for project ${project.id}: ${message}` };
    }
    await this.store.appendEvent({
      type: 'session.created',
      at: now,
      data: { sessionId, projectId: project.id, chatId: input.chatId },
    });
    const chat: ChatContext = {
      chatId: input.chatId,
      chatType: input.chatType,
      currentProjectId: project.id,
      currentSessionId: sessionId,
    };
    await this.store.saveChat(chat);

    return { reply: `Created session ${sessionId} for project ${project.id}.` };
  }

  private async sendToCurrentSession(chatId: string, text: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session. Run /projects and /new <project> first.' };
    }
    const session = await this.store.getSession(chat.currentSessionId);
    if (!session || session.status !== 'running') {
      return { reply: 'No running session. Run /new <project> first.' };
    }
    try {
      await this.runner.send(chat.currentSessionId, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      await this.store.saveSession({
        ...session,
        status: 'interrupted',
        lastSummary: `Failed to send to Codex: ${message}`,
        updatedAt: failedAt,
      });
      await this.store.appendEvent({
        type: 'session.send_failed',
        at: failedAt,
        data: { sessionId: chat.currentSessionId, chatId, reason: message },
      });
      return { reply: 'No running session. Run /new <project> first.' };
    }
    await this.store.appendEvent({
      type: 'session.input',
      at: new Date().toISOString(),
      data: { sessionId: chat.currentSessionId },
    });
    return { reply: `Sent to Codex session ${chat.currentSessionId}.` };
  }

  private async status(chatId: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }
    const session = await this.store.getSession(chat.currentSessionId);
    return {
      reply: `Project: ${chat.currentProjectId}\nSession: ${chat.currentSessionId}\nStatus: ${session?.status ?? 'unknown'}`,
    };
  }

  private async tail(chatId: string, requestedCount?: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }
    const count = requestedCount ? Number.parseInt(requestedCount, 10) : 80;
    const lines = await this.store.tailSessionLog(chat.currentSessionId, Number.isFinite(count) && count > 0 ? count : 80);
    return { reply: formatTail(lines) };
  }

  private async markExited(sessionId: string, exitCode: number | undefined): Promise<void> {
    const latest = await this.store.getSession(sessionId);
    if (!latest) {
      await this.store.appendEvent({
        type: 'session.exit_missing_record',
        at: new Date().toISOString(),
        data: { sessionId, exitCode },
      });
      return;
    }
    await this.store.saveSession({
      ...latest,
      status: 'exited',
      exitCode,
      updatedAt: new Date().toISOString(),
    });
  }

  private async appendSessionOutput(sessionId: string, text: string): Promise<void> {
    await this.store.appendSessionLog(sessionId, text);
  }

  private async recordBackgroundError(type: string, error: unknown, data: Record<string, unknown>): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.store.appendEvent({
      type,
      at: new Date().toISOString(),
      data: { ...data, reason: message },
    });
  }
}
