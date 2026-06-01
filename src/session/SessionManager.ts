import type { BotConfig, ChatContext, ChatType, SessionRecord } from '../domain/types.js';
import { ApprovalManager } from '../approvals/ApprovalManager.js';
import { parseIncomingText } from '../commands/CommandRouter.js';
import { createCodexSessionId, type CodexRunner } from '../codex/CodexRunner.js';
import { CodexSessionRegistry } from '../codex/CodexSessionRegistry.js';
import { extractFinalAnswer, formatCompletionNotification } from '../notifications/FinalAnswerExtractor.js';
import { formatLogTail, formatReadableTail } from '../output/OutputFormatter.js';
import { sanitizeTerminalOutput } from '../output/TerminalOutputSanitizer.js';
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

export interface CodexSessionDiscovery {
  discoverForProject(request: { projectPath: string; startedAt: string }): Promise<
    | { ok: true; codexSessionId: string }
    | { ok: false; reason: 'not-found' | 'ambiguous' }
  >;
}

export interface Notifier {
  sendText(chatId: string, text: string): Promise<void>;
}

export interface SessionManagerDeps {
  notifier?: Notifier;
  codexSessionRegistry?: CodexSessionDiscovery;
  codexSessionDiscovery?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
}

const DEFAULT_CODEX_SESSION_DISCOVERY_MAX_ATTEMPTS = 10;
const DEFAULT_CODEX_SESSION_DISCOVERY_RETRY_DELAY_MS = 250;

interface PendingTurn {
  id: string;
  sessionId: string;
  chatId: string;
  projectId: string;
  prompt: string;
  startedAt: string;
  outputStartIndex: number;
  outputStartOffset: number;
  notified: boolean;
  lastCandidate?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class SessionManager {
  private readonly approvalManager: ApprovalManager;
  private readonly chatQueues = new Map<string, Promise<unknown>>();
  private readonly pendingTurns = new Map<string, PendingTurn>();

  constructor(
    private readonly config: BotConfig,
    private readonly store: FileStateStore,
    private readonly runner: CodexRunner,
    private readonly deps: SessionManagerDeps = {},
  ) {
    this.approvalManager = new ApprovalManager(store);
  }

  async handleText(input: IncomingBotText): Promise<BotTextResult> {
    return this.withChatQueue(input.chatId, () => this.handleTextQueued(input));
  }

  private async handleTextQueued(input: IncomingBotText): Promise<BotTextResult> {
    if (!isAuthorizedMessage(this.config, input)) {
      return { reply: 'You are not allowed to control this bot.' };
    }

    const parsed = parseIncomingText(input.text);
    if (parsed.kind === 'message') {
      return this.sendToCurrentSession(input, parsed.text);
    }

    switch (parsed.name) {
      case 'help':
        return { reply: this.helpText() };
      case 'projects':
        return { reply: this.config.projects.map((project) => `${project.id}: ${project.name}`).join('\n') };
      case 'use':
        return this.useProject(input, parsed.args[0]);
      case 'new':
        return this.createSession(input, parsed.args[0]);
      case 'resume':
        return this.resumeSession(input, parsed.args[0], parsed.args[1]);
      case 'send':
        return this.sendToCurrentSession(input, parsed.args[0] ?? '');
      case 'status':
        return this.status(input.chatId);
      case 'tail':
        return this.tail(input.chatId, parsed.args[0]);
      case 'rawtail':
        return this.rawTail(input.chatId, parsed.args[0]);
      case 'stop':
        return this.stopCurrentSession(input);
      case 'sessions':
        return this.sessions(input.chatId);
      case 'approve':
        return this.resolveApproval(input.chatId, parsed.args[0], 'approved', input.userId);
      case 'reject':
        return this.resolveApproval(input.chatId, parsed.args[0], 'rejected', input.userId);
      default:
        return { reply: `Unknown command: /${parsed.name}` };
    }
  }

  private async withChatQueue<T>(chatId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.chatQueues.get(chatId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(action);
    const chain = current.catch(() => undefined);
    this.chatQueues.set(chatId, chain);

    try {
      return await current;
    } finally {
      if (this.chatQueues.get(chatId) === chain) {
        this.chatQueues.delete(chatId);
      }
    }
  }

  private async useProject(input: IncomingBotText, projectId?: string): Promise<BotTextResult> {
    if (!projectId || !resolveProject(this.config, projectId)) {
      return { reply: `Unknown project: ${projectId ?? ''}`.trim() };
    }
    const existingChat = await this.store.getChat(input.chatId);
    const currentSession = existingChat?.currentSessionId ? await this.store.getSession(existingChat.currentSessionId) : undefined;
    if (currentSession && isActiveSession(currentSession) && currentSession.projectId !== projectId) {
      return {
        reply: `Current session ${currentSession.id} is still running. Run /stop and approve it before switching projects.`,
      };
    }
    await this.store.saveChat({
      chatId: input.chatId,
      chatType: input.chatType,
      currentProjectId: projectId,
      currentSessionId: currentSession && isActiveSession(currentSession) ? currentSession.id : undefined,
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
    const previousSession = previousChat?.currentSessionId ? await this.store.getSession(previousChat.currentSessionId) : undefined;
    if (previousSession && isActiveSession(previousSession)) {
      return {
        reply: `Current session ${previousSession.id} is still running. Run /stop and approve it before starting a new session.`,
      };
    }

    return this.startCodexSession(input, project, {
      mode: { kind: 'new' },
      replyVerb: 'Created',
      eventType: 'session.created',
      discoverCodexSessionId: true,
    });
  }

  private async resumeSession(input: IncomingBotText, target?: string, projectId?: string): Promise<BotTextResult> {
    if (!target) {
      return { reply: 'Usage: /resume <session> [project]' };
    }

    const previousChat = await this.store.getChat(input.chatId);
    const previousSession = previousChat?.currentSessionId ? await this.store.getSession(previousChat.currentSessionId) : undefined;
    if (previousSession && isActiveSession(previousSession)) {
      return {
        reply: `Current session ${previousSession.id} is still running. Run /stop before resuming another session.`,
      };
    }

    const isCodeBotSessionId = target.startsWith('sess_');
    if (!isValidSessionTarget(target)) {
      return { reply: `Invalid session target: ${target}` };
    }
    let selectedProjectId: string | undefined;
    let sourceSession: SessionRecord | undefined;
    let nativeStoredSession: SessionRecord | undefined;
    if (isCodeBotSessionId) {
      sourceSession = await this.store.getSession(target);
      if (!sourceSession) {
        return { reply: `Session not found: ${target}` };
      }
      if (sourceSession.chatId !== input.chatId) {
        return { reply: `Session not found: ${target}` };
      }
      if (!sourceSession.codexSessionId) {
        const sourceProject = resolveProject(this.config, sourceSession.projectId);
        if (!sourceProject) {
          return { reply: `Unknown project: ${sourceSession.projectId}` };
        }
        const discoveredCodexSessionId = await this.discoverAndStoreCodexSessionId(sourceSession.id, sourceProject.path, sourceSession.createdAt);
        if (!discoveredCodexSessionId) {
          return { reply: `Session ${target} cannot be resumed because no Codex session id was captured.` };
        }
        sourceSession = { ...sourceSession, codexSessionId: discoveredCodexSessionId };
      }
      if (projectId && projectId !== sourceSession.projectId) {
        return { reply: `Project ${projectId} does not match session ${target} project ${sourceSession.projectId}.` };
      }
      selectedProjectId = sourceSession.projectId;
    } else {
      selectedProjectId = projectId ?? previousChat?.currentProjectId;
      const storedSessions = await this.store.listSessions();
      const matchingNativeSessions = storedSessions.filter((session) => session.codexSessionId === target);
      if (matchingNativeSessions.length > 0) {
        nativeStoredSession = matchingNativeSessions.find((session) => session.chatId === input.chatId);
        if (!nativeStoredSession) {
          return { reply: `Session not found: ${target}` };
        }
      }
    }

    if (!selectedProjectId) {
      return { reply: 'Choose a project with /projects and /resume <codex-session-id> <project>.' };
    }
    if (nativeStoredSession && nativeStoredSession.projectId !== selectedProjectId) {
      return { reply: `Project ${selectedProjectId} does not match session ${nativeStoredSession.id} project ${nativeStoredSession.projectId}.` };
    }
    const project = resolveProject(this.config, selectedProjectId);
    if (!project) {
      return { reply: `Unknown project: ${selectedProjectId}` };
    }

    const resumeTarget = isCodeBotSessionId ? sourceSession!.codexSessionId! : target;
    return this.startCodexSession(input, project, {
      mode: { kind: 'resume', target: resumeTarget },
      replyVerb: 'Resumed',
      eventType: 'session.resumed',
      sessionFields: isCodeBotSessionId
        ? { codexSessionId: resumeTarget, resumedFromSessionId: target, resumeSource: 'code_bot' }
        : { codexSessionId: target, resumeSource: 'codex' },
    });
  }

  private async startCodexSession(
    input: IncomingBotText,
    project: NonNullable<ReturnType<typeof resolveProject>>,
    options: {
      mode: { kind: 'new' } | { kind: 'resume'; target: string };
      replyVerb: 'Created' | 'Resumed';
      eventType: 'session.created' | 'session.resumed';
      sessionFields?: Partial<SessionRecord>;
      discoverCodexSessionId?: boolean;
    },
  ): Promise<BotTextResult> {
    const now = new Date().toISOString();
    const startedAt = now;
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
      ...options.sessionFields,
    };
    await this.store.saveSession(session);
    try {
      await this.runner.start({
        sessionId,
        cwd: project.path,
        args: project.codexArgs,
        mode: options.mode,
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
        lastSummary:
          options.mode.kind === 'resume' ? `Failed to resume Codex session ${options.mode.target}: ${message}` : `Failed to start Codex: ${message}`,
        updatedAt: failedAt,
      });
      await this.store.appendEvent({
        type: 'session.start_failed',
        at: failedAt,
        data: { sessionId, projectId: project.id, chatId: input.chatId, reason: message },
      });
      if (options.mode.kind === 'resume') {
        return { reply: `Failed to resume Codex session ${options.mode.target} for project ${project.id}: ${message}` };
      }
      return { reply: `Failed to start Codex for project ${project.id}: ${message}` };
    }
    await this.store.appendEvent({
      type: options.eventType,
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
    if (options.discoverCodexSessionId) {
      void this.discoverAndStoreCodexSessionId(sessionId, project.path, startedAt).catch((error) =>
        this.recordBackgroundError('session.codex_id_discovery_failed', error, { sessionId, projectPath: project.path }).catch(() => undefined),
      );
    }

    return { reply: `${options.replyVerb} session ${sessionId} for project ${project.id}.` };
  }

  private codexSessionRegistry(): CodexSessionDiscovery {
    return this.deps.codexSessionRegistry ?? new CodexSessionRegistry(process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`);
  }

  private async discoverAndStoreCodexSessionId(sessionId: string, projectPath: string, startedAt: string): Promise<string | undefined> {
    let lastFailureReason: 'not-found' | 'ambiguous' = 'not-found';
    const maxAttempts = Math.max(1, this.deps.codexSessionDiscovery?.maxAttempts ?? DEFAULT_CODEX_SESSION_DISCOVERY_MAX_ATTEMPTS);
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let result: Awaited<ReturnType<CodexSessionDiscovery['discoverForProject']>>;
      try {
        result = await this.codexSessionRegistry().discoverForProject({ projectPath, startedAt });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.store.appendEvent({
          type: 'session.codex_id_discovery_failed',
          at: new Date().toISOString(),
          data: { sessionId, projectPath, reason: message },
        });
        return undefined;
      }
      if (result.ok) {
        const discoveredAt = new Date().toISOString();
        await this.store.updateSession(sessionId, (latest) => ({
          ...latest,
          codexSessionId: result.codexSessionId,
          updatedAt: discoveredAt,
        }));
        await this.store.appendEvent({
          type: 'session.codex_id_discovered',
          at: discoveredAt,
          data: { sessionId, projectPath, codexSessionId: result.codexSessionId },
        });
        return result.codexSessionId;
      }
      lastFailureReason = result.reason;
      if (attempt < maxAttempts) {
        await this.codexSessionDiscoverySleep(this.deps.codexSessionDiscovery?.retryDelayMs ?? DEFAULT_CODEX_SESSION_DISCOVERY_RETRY_DELAY_MS);
      }
    }
    await this.store.appendEvent({
      type: 'session.codex_id_discovery_failed',
      at: new Date().toISOString(),
      data: { sessionId, projectPath, reason: lastFailureReason },
    });
    return undefined;
  }

  private async codexSessionDiscoverySleep(ms: number): Promise<void> {
    const sleep = this.deps.codexSessionDiscovery?.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    await sleep(ms);
  }

  private notificationsEnabled(): boolean {
    return this.config.notifications.enabled && !!this.deps.notifier;
  }

  private async sendToCurrentSession(input: IncomingBotText, text: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(input.chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session. Run /projects and /new <project> first.' };
    }
    const session = await this.store.getSession(chat.currentSessionId);
    if (!session || session.status !== 'running') {
      return { reply: 'No running session. Run /new <project> first.' };
    }
    if (this.notificationsEnabled() && this.pendingTurns.has(chat.currentSessionId)) {
      await this.store.appendEvent({
        type: 'notification.turn_busy_rejected',
        at: new Date().toISOString(),
        data: { sessionId: chat.currentSessionId, chatId: input.chatId },
      }).catch((error) =>
        this.recordBackgroundError('notification.turn_busy_rejected_persist_failed', error, {
          sessionId: chat.currentSessionId,
          chatId: input.chatId,
        }).catch(() => undefined),
      );
      return { reply: '当前 session 正在执行任务，请等待完成后再发送新任务，或使用 /tail 查看进度。' };
    }

    const notificationEnabled = this.notificationsEnabled();
    const notificationStartedAt = new Date().toISOString();
    if (notificationEnabled) {
      const outputStartIndex = (await this.store.tailSessionLog(chat.currentSessionId, 100000)).length;
      const outputStartOffset = await this.store.sessionLogSize(chat.currentSessionId);
      this.pendingTurns.set(chat.currentSessionId, {
        id: `${chat.currentSessionId}:${Date.now()}`,
        sessionId: chat.currentSessionId,
        chatId: input.chatId,
        projectId: session.projectId,
        prompt: text,
        startedAt: notificationStartedAt,
        outputStartIndex,
        outputStartOffset,
        notified: false,
      });
    }

    try {
      await this.runner.send(chat.currentSessionId, text);
    } catch (error) {
      this.pendingTurns.delete(chat.currentSessionId);
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();
      await this.store.updateSession(chat.currentSessionId, (latest) => {
        if (!isActiveSession(latest)) {
          return latest;
        }
        return {
          ...latest,
          status: 'interrupted',
          lastSummary: `Failed to send to Codex: ${message}`,
          updatedAt: failedAt,
        };
      });
      await this.store.appendEvent({
        type: 'session.send_failed',
        at: failedAt,
        data: { sessionId: chat.currentSessionId, chatId: input.chatId, reason: message },
      });
      return { reply: 'No running session. Run /new <project> first.' };
    }
    if (notificationEnabled) {
      await this.store.appendEvent({
        type: 'notification.turn_started',
        at: notificationStartedAt,
        data: { sessionId: chat.currentSessionId, chatId: input.chatId, projectId: session.projectId },
      }).catch((error) =>
        this.recordBackgroundError('notification.turn_started_persist_failed', error, {
          sessionId: chat.currentSessionId,
          chatId: input.chatId,
          projectId: session.projectId,
        }).catch(() => undefined),
      );
      return { reply: `已发送给 Codex，完成后我会主动通知你。\nsession: ${chat.currentSessionId}` };
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
    const session = chat?.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
    const pendingApprovals = await this.store.listPendingApprovalsByChat(chatId);
    return {
      reply: [
        `Project: ${chat?.currentProjectId ?? 'none'}`,
        `Session: ${chat?.currentSessionId ?? 'none'}`,
        `Status: ${session?.status ?? 'none'}`,
        `Summary: ${session?.lastSummary ?? 'none'}`,
        `Pending approvals: ${pendingApprovals.length > 0 ? pendingApprovals.map((approval) => approval.id).join(', ') : 'none'}`,
      ].join('\n'),
    };
  }

  private async tail(chatId: string, requestedCount?: string): Promise<BotTextResult> {
    const rawLines = await this.tailRawLines(chatId, requestedCount);
    if ('reply' in rawLines) {
      return rawLines;
    }

    const sanitized = sanitizeTerminalOutput(rawLines.lines);
    if (sanitized.readableLines.length === 0) {
      return { reply: 'No readable output yet. Use /rawtail 80 for raw terminal logs.' };
    }

    return { reply: formatReadableTail(sanitized.readableLines) };
  }

  private async rawTail(chatId: string, requestedCount?: string): Promise<BotTextResult> {
    const rawLines = await this.tailRawLines(chatId, requestedCount);
    if ('reply' in rawLines) {
      return rawLines;
    }

    return { reply: formatLogTail(rawLines.lines) };
  }

  private async tailRawLines(chatId: string, requestedCount?: string): Promise<BotTextResult | { lines: string[] }> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }

    let count = 80;
    if (requestedCount !== undefined) {
      if (!/^[1-9]\d*$/.test(requestedCount)) {
        return { reply: 'Invalid tail count.' };
      }
      count = Number.parseInt(requestedCount, 10);
    }

    return { lines: await this.store.tailSessionLog(chat.currentSessionId, count) };
  }

  private async stopCurrentSession(input: IncomingBotText): Promise<BotTextResult> {
    const chat = await this.store.getChat(input.chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }
    const session = await this.store.getSession(chat.currentSessionId);
    if (!session || !isActiveSession(session)) {
      await this.store.saveChat({
        chatId: input.chatId,
        chatType: input.chatType,
        currentProjectId: chat.currentProjectId,
        currentSessionId: undefined,
      });
      return { reply: 'No running session.' };
    }
    const approval = await this.approvalManager.requestApproval({
      sessionId: session.id,
      chatId: input.chatId,
      requestedBy: input.userId,
      action: 'stop_session',
      riskSummary: `Stop session ${session.id}`,
      ttlMs: 5 * 60 * 1000,
    });
    return { reply: this.approvalManager.buildTextFallback(approval) };
  }

  private async sessions(chatId: string): Promise<BotTextResult> {
    const sessions = await this.store.listSessionsByChat(chatId, 10);
    if (sessions.length === 0) {
      return { reply: 'No sessions for this chat yet. Run /new <project> to start one.' };
    }
    const chat = await this.store.getChat(chatId);
    return {
      reply: sessions
        .map((session) => `${session.id} | ${sessionResumeState(session, chat?.currentSessionId)} | ${session.projectId} | ${session.status} | ${session.updatedAt}`)
        .join('\n'),
    };
  }

  private async resolveApproval(chatId: string, approvalId: string | undefined, status: 'approved' | 'rejected', userId: string): Promise<BotTextResult> {
    if (!approvalId) {
      const command = status === 'approved' ? '/approve' : '/reject';
      return { reply: `Usage: ${command} <id>` };
    }
    try {
      const resolved = await this.approvalManager.resolve(approvalId, status, userId, chatId);
      if (status === 'approved' && (resolved.action === 'stop_session' || resolved.riskSummary === `Stop session ${resolved.sessionId}`)) {
        return this.executeApprovedStop(resolved.sessionId, userId);
      }
      const action = status === 'approved' ? 'Approved' : 'Rejected';
      return { reply: `${action} approval ${resolved.id}.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { reply: message };
    }
  }

  private async executeApprovedStop(sessionId: string, userId: string): Promise<BotTextResult> {
    const initialSession = await this.store.getSession(sessionId);
    if (!initialSession) {
      return { reply: `Session not found: ${sessionId}` };
    }
    if (!isActiveSession(initialSession)) {
      return { reply: `Session ${sessionId} is already ${initialSession.status}.` };
    }
    const stoppingAt = new Date().toISOString();
    let shouldStop = false;
    const preStopSession = await this.store.updateSession(sessionId, (latest) => {
      if (!isActiveSession(latest)) {
        return latest;
      }
      shouldStop = true;
      return {
        ...latest,
        status: 'interrupted',
        stopRequested: true,
        lastSummary: latest.lastSummary ?? `Stopped by ${userId}`,
        updatedAt: stoppingAt,
      };
    });
    if (!preStopSession) {
      return { reply: `Session not found: ${sessionId}` };
    }
    if (!shouldStop) {
      return { reply: `Session ${sessionId} is already ${preStopSession.status}.` };
    }

    try {
      await this.runner.stop(sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.updateSession(sessionId, (latest) => ({
        ...latest,
        stopRequested: undefined,
        updatedAt: new Date().toISOString(),
      }));
      await this.store.appendEvent({
        type: 'session.stop_failed',
        at: new Date().toISOString(),
        data: { sessionId, chatId: initialSession.chatId, reason: message },
      });
      return { reply: `Failed to stop session ${sessionId}: ${message}` };
    }
    const stoppedAt = new Date().toISOString();
    await this.store.updateSession(sessionId, (latest) => ({
      ...latest,
      status: 'interrupted',
      stopRequested: true,
      lastSummary: latest.lastSummary ?? preStopSession.lastSummary,
      updatedAt: stoppedAt,
    }));
    await this.store.appendEvent({
      type: 'session.stopped',
      at: stoppedAt,
      data: { sessionId, chatId: initialSession.chatId, userId },
    });

    const chat = await this.store.getChat(initialSession.chatId);
    if (chat?.currentSessionId === sessionId) {
      await this.store.saveChat({
        chatId: chat.chatId,
        chatType: chat.chatType,
        currentProjectId: chat.currentProjectId,
        currentSessionId: undefined,
      });
    }
    return { reply: `Stopped session ${sessionId}.` };
  }

  private async markExited(sessionId: string, exitCode: number | undefined): Promise<void> {
    const exitedAt = new Date().toISOString();
    const updated = await this.store.updateSession(sessionId, (latest) => {
      const nextStatus = latest.status === 'interrupted' && latest.stopRequested ? 'interrupted' : 'exited';
      return {
        ...latest,
        status: nextStatus,
        exitCode,
        updatedAt: exitedAt,
      };
    });
    if (!updated) {
      await this.store.appendEvent({
        type: 'session.exit_missing_record',
        at: new Date().toISOString(),
        data: { sessionId, exitCode },
      });
    }
    if (this.pendingTurns.has(sessionId)) {
      await this.completePendingTurn(sessionId, 'exit').catch((error) =>
        this.recordBackgroundError('notification.send_failed', error, { sessionId }).catch(() => undefined),
      );
    }
  }

  async handleRunnerOutput(sessionId: string, text: string): Promise<void> {
    await this.appendSessionOutput(sessionId, text);
  }

  private async appendSessionOutput(sessionId: string, text: string): Promise<void> {
    await this.store.appendSessionLog(sessionId, text);
    await this.observePendingTurnOutput(sessionId);
  }

  private async observePendingTurnOutput(sessionId: string): Promise<void> {
    const turn = this.pendingTurns.get(sessionId);
    if (!turn || turn.notified) {
      return;
    }
    const pendingLines = await this.pendingTurnLogLines(sessionId, turn);
    const extraction = extractFinalAnswer({
      rawLines: pendingLines,
      prompt: turn.prompt,
      maxChars: this.config.notifications.maxFinalChars,
      requireCompletionMarker: true,
    });
    if (extraction.kind !== 'answer') {
      if (turn.timer) {
        clearTimeout(turn.timer);
        turn.timer = undefined;
      }
      turn.lastCandidate = undefined;
      return;
    }
    if (turn.lastCandidate === extraction.text) {
      return;
    }
    turn.lastCandidate = extraction.text;
    if (turn.timer) {
      clearTimeout(turn.timer);
    }
    await this.store.appendEvent({
      type: 'notification.answer_candidate_updated',
      at: new Date().toISOString(),
      data: { sessionId, chatId: turn.chatId },
    }).catch((error) =>
      this.recordBackgroundError('notification.answer_candidate_updated_persist_failed', error, {
        sessionId,
        chatId: turn.chatId,
      }).catch(() => undefined),
    );
    turn.timer = setTimeout(() => {
      return this.completePendingTurn(sessionId, 'stable').catch((error) =>
        this.recordBackgroundError('notification.send_failed', error, { sessionId }).catch(() => undefined),
      );
    }, this.config.notifications.idleMs);
  }

  private async completePendingTurn(sessionId: string, reason: 'stable' | 'exit'): Promise<void> {
    const turn = this.pendingTurns.get(sessionId);
    if (!turn || turn.notified) {
      return;
    }
    turn.notified = true;
    try {
      const lines = await this.pendingTurnLogLines(sessionId, turn);
      const extraction = extractFinalAnswer({
        rawLines: lines,
        prompt: turn.prompt,
        maxChars: this.config.notifications.maxFinalChars,
        requireCompletionMarker: reason === 'stable',
      });
      const message = formatCompletionNotification({ projectId: turn.projectId, sessionId, extraction });
      await this.deps.notifier!.sendText(turn.chatId, message);
      await this.store.appendEvent({
        type: reason === 'exit' ? 'notification.turn_exit_fallback' : 'notification.turn_completed',
        at: new Date().toISOString(),
        data: { sessionId, chatId: turn.chatId, projectId: turn.projectId, extraction: extraction.kind },
      }).catch((error) =>
        this.recordBackgroundError('notification.turn_completed_persist_failed', error, {
          sessionId,
          chatId: turn.chatId,
          projectId: turn.projectId,
        }).catch(() => undefined),
      );
    } finally {
      if (turn.timer) {
        clearTimeout(turn.timer);
      }
      this.pendingTurns.delete(sessionId);
    }
  }

  private async pendingTurnLogLines(sessionId: string, turn: PendingTurn): Promise<string[]> {
    if (turn.outputStartOffset !== undefined) {
      return this.store.sessionLogLinesFrom(sessionId, turn.outputStartOffset);
    }
    const lines = await this.store.tailSessionLog(sessionId, 100000);
    return lines.slice(turn.outputStartIndex);
  }

  private async recordBackgroundError(type: string, error: unknown, data: Record<string, unknown>): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.store.appendEvent({
      type,
      at: new Date().toISOString(),
      data: { ...data, reason: message },
    });
  }

  private helpText(): string {
    const commands =
      '/help\n/projects\n/use <project>\n/new [project]\n/resume <session> [project]\n/send <text>\n/status\n/tail [n]\n/rawtail [n]\n/stop\n/sessions\n/approve <id>\n/reject <id>';
    const resumeHelp = [
      'Resume: /resume <session> [project]',
      '- session can be a code_bot session id from /sessions or a Codex native id',
    ].join('\n');
    const restrictions = [
      'Restrictions:',
      `- Allowed users: ${this.config.allowedUsers.length}`,
      `- Allowed chats: ${this.config.allowedChatIds.length}`,
      `- Projects: ${this.config.projects.map((project) => project.id).join(', ') || 'none'}`,
    ].join('\n');
    return `${commands}\n\n${resumeHelp}\n\n${restrictions}`;
  }
}

function isActiveSession(session: SessionRecord): boolean {
  return session.status === 'running' || session.status === 'starting';
}

function isValidSessionTarget(target: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(target) && target !== '.' && target !== '..' && !target.startsWith('-');
}

function sessionResumeState(session: SessionRecord, currentSessionId: string | undefined): 'current' | 'resumable' | 'not-resumable' {
  if (session.id === currentSessionId) {
    return 'current';
  }
  return session.codexSessionId ? 'resumable' : 'not-resumable';
}
