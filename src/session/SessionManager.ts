import type { BotConfig, ChatContext, ChatType, SessionRecord } from '../domain/types.js';
import { parseIncomingText } from '../commands/CommandRouter.js';
import { createCodexSessionId, type CodexRunner } from '../codex/CodexRunner.js';
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
      case 'projects':
        return { reply: this.config.projects.map((project) => `${project.id}: ${project.name}`).join('\n') };
      case 'new':
        return this.createSession(input, parsed.args[0]);
      case 'send':
        return this.sendToCurrentSession(input.chatId, parsed.args[0] ?? '');
      case 'status':
        return this.status(input.chatId);
      default:
        return { reply: `Unknown command: /${parsed.name}` };
    }
  }

  private async createSession(input: IncomingBotText, projectId?: string): Promise<BotTextResult> {
    const selectedProjectId = projectId ?? (await this.store.getChat(input.chatId))?.currentProjectId;
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
    const chat: ChatContext = {
      chatId: input.chatId,
      chatType: input.chatType,
      currentProjectId: project.id,
      currentSessionId: sessionId,
    };

    await this.store.saveSession(session);
    await this.store.saveChat(chat);
    try {
      await this.runner.start({
        sessionId,
        cwd: project.path,
        args: project.codexArgs,
        onOutput: (text) => {
          this.appendSessionOutput(sessionId, text).catch((error) =>
            this.recordBackgroundError('session.output_persist_failed', error, { sessionId }),
          );
        },
        onExit: (exitCode) => {
          this.markExited(session, exitCode).catch((error) =>
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
    await this.runner.send(chat.currentSessionId, text);
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

  private async markExited(session: SessionRecord, exitCode: number | undefined): Promise<void> {
    await this.store.saveSession({
      ...session,
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
