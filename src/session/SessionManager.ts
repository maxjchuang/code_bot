import { createHash } from 'node:crypto';
import type { BotConfig, ChatContext, ChatType, SessionRecord } from '../domain/types.js';
import { ApprovalManager } from '../approvals/ApprovalManager.js';
import { parseIncomingText } from '../commands/CommandRouter.js';
import { createCodexSessionId, type CodexRunner } from '../codex/CodexRunner.js';
import { CodexSessionRegistry } from '../codex/CodexSessionRegistry.js';
import { renderFeishuMessage, type BotMessage, type RenderedFeishuMessage } from '../feishu/FeishuMessageRenderer.js';
import {
  extractFinalAnswer,
  formatCompletionNotification,
  inspectFinalAnswer,
  type FinalAnswerExtraction,
} from '../notifications/FinalAnswerExtractor.js';
import { FileCodexObservationStore, type CodexObservationStore } from '../observations/CodexObservationStore.js';
import { formatLogTail, formatReadableTail } from '../output/OutputFormatter.js';
import { sanitizeTerminalOutput } from '../output/TerminalOutputSanitizer.js';
import { FileStateStore } from '../state/FileStateStore.js';
import { isAuthorizedMessage, resolveProject } from '../security/guards.js';
import { createAppLogger, type AppLogger, type LogLevel } from '../logging/AppLogger.js';
import { formatStatusMessage } from '../status/StatusMessageFormatter.js';
import { createCodexStatusService, type CodexStatusLookupResult } from '../status/CodexStatusService.js';
import { readCodexModelCatalog, type CodexModelCatalog, type CodexModelInfo } from '../models/CodexModelCatalog.js';

export interface IncomingBotText {
  chatId: string;
  chatType: ChatType;
  userId: string;
  text: string;
  wasMentioned?: boolean;
}

export interface BotTextResult {
  reply: string;
  renderedReply?: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage };
}

export interface CodexSessionDiscovery {
  discoverForProject(request: { projectPath: string; startedAt: string }): Promise<
    | { ok: true; codexSessionId: string }
    | { ok: false; reason: 'not-found' | 'ambiguous' }
  >;
}

export interface Notifier {
  sendText(chatId: string, text: string): Promise<void>;
  sendRenderedMessage?(
    chatId: string,
    message: { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage },
  ): Promise<void>;
}

export interface ModelCatalogReader {
  read(): Promise<CodexModelCatalog>;
}

export interface SessionManagerDeps {
  logger?: Pick<typeof console, 'info' | 'error'>;
  logLevel?: LogLevel | string;
  notifier?: Notifier;
  codexSessionRegistry?: CodexSessionDiscovery;
  codexSessionDiscovery?: {
    maxAttempts?: number;
    retryDelayMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  sendConfirmation?: {
    initialWaitMs?: number;
    retryWaitMs?: number;
    pollIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
  };
  codexObservationStore?: CodexObservationStore;
  codexStatus?: {
    liveFetchTimeoutMs?: number;
    quietMs?: number;
  };
  modelCatalog?: ModelCatalogReader;
}

const DEFAULT_CODEX_SESSION_DISCOVERY_MAX_ATTEMPTS = 10;
const DEFAULT_CODEX_SESSION_DISCOVERY_RETRY_DELAY_MS = 250;
const SEND_TEXT_PREVIEW_LIMIT = 120;
const PTY_SEND_TERMINATOR = '\r';
const SEND_SUBMIT_RETRY_LIMIT = 1;
const DEFAULT_SEND_CONFIRMATION_INITIAL_WAIT_MS = 3_000;
const DEFAULT_SEND_CONFIRMATION_RETRY_WAIT_MS = 2_000;
const DEFAULT_SEND_CONFIRMATION_POLL_INTERVAL_MS = 100;
const DEFAULT_CODEX_STATUS_LIVE_FETCH_TIMEOUT_MS = 2_000;
const DEFAULT_CODEX_STATUS_QUIET_MS = 75;

interface PendingTurn {
  id: string;
  sessionId: string;
  chatId: string;
  projectId: string;
  prompt: string;
  startedAt: string;
  outputStartIndex?: number;
  outputStartOffset?: number;
  notified: boolean;
  lastCandidate?: string;
  candidateUpdateCount: number;
  timer?: ReturnType<typeof setTimeout>;
  submitRetryCount: number;
  processingState: 'pending_confirmation' | 'confirmed_processing' | 'submit_retry_sent' | 'unconfirmed_failed';
}

type CurrentTurnAnswer =
  | { kind: 'answer'; text: string; source: 'observation' | 'pty' }
  | { kind: 'empty' };

type SendConfirmationResult = {
  confirmed: boolean;
  retryUsed: boolean;
};

interface LiveStatusWaiter {
  chunks: string[];
  resolve: (text: string) => void;
  reject: (reason: unknown) => void;
  quietTimer?: ReturnType<typeof setTimeout>;
  abortHandler: () => void;
}

export class SessionManager {
  private readonly approvalManager: ApprovalManager;
  private readonly logger: AppLogger;
  private readonly observationStore: CodexObservationStore;
  private readonly codexStatusService: ReturnType<typeof createCodexStatusService>;
  private readonly chatQueues = new Map<string, Promise<unknown>>();
  private readonly pendingTurns = new Map<string, PendingTurn>();
  private readonly queuedTurns = new Map<string, PendingTurn[]>();
  private readonly ptyDebugBuffers = new Map<string, string>();
  private readonly liveStatusWaiters = new Map<string, Set<LiveStatusWaiter>>();

  constructor(
    private readonly config: BotConfig,
    private readonly store: FileStateStore,
    private readonly runner: CodexRunner,
    private readonly deps: SessionManagerDeps = {},
  ) {
    this.approvalManager = new ApprovalManager(store);
    this.logger = createAppLogger({ level: deps.logLevel, sink: deps.logger ?? console });
    this.observationStore =
      deps.codexObservationStore ??
      new FileCodexObservationStore({
        codexHome: process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`,
      });
    this.codexStatusService = createCodexStatusService({
      fetchLiveStatusText: ({ sessionId, signal }) => this.fetchLiveCodexStatusText(sessionId, signal),
      observationStore: this.observationStore,
      timeoutMs: deps.codexStatus?.liveFetchTimeoutMs ?? DEFAULT_CODEX_STATUS_LIVE_FETCH_TIMEOUT_MS,
    });
  }

  async handleText(input: IncomingBotText): Promise<BotTextResult> {
    const result = await this.withChatQueue(input.chatId, () => this.handleTextQueued(input));
    return this.decorateRenderedReply(input.text, result);
  }

  private async handleTextQueued(input: IncomingBotText): Promise<BotTextResult> {
    if (!isAuthorizedMessage(this.config, input)) {
      return { reply: 'You are not allowed to control this bot.' };
    }

    const parsed = parseIncomingText(input.text);
    if (input.chatType === 'group' && input.wasMentioned === false) {
      return { reply: '' };
    }
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
      case 'model':
        return this.model(input.chatId, parsed.args);
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
        reply: `Current session ${currentSession.id} is still running. Run /stop before switching projects.`,
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
    const selectedProjectId = projectId ?? previousChat?.currentProjectId ?? this.singleConfiguredProject()?.id;
    if (!selectedProjectId) {
      return { reply: 'Choose a project with /projects and /new <project>.' };
    }
    const project = resolveProject(this.config, selectedProjectId);
    if (!project) {
      return { reply: `Unknown project: ${selectedProjectId}` };
    }
    const previousSession = previousChat?.currentSessionId ? await this.store.getSession(previousChat.currentSessionId) : undefined;
    if (previousSession && isActiveSession(previousSession)) {
      const stopped = await this.executeApprovedStop(previousSession.id, input.userId);
      if (!stopped.reply.startsWith('Stopped session ')) {
        return stopped;
      }

      const created = await this.startCodexSession(input, project, {
        mode: { kind: 'new' },
        replyVerb: 'Created',
        eventType: 'session.created',
        discoverCodexSessionId: true,
      });
      return {
        ...created,
        reply: `${stopped.reply}\n${created.reply}`,
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
      selectedProjectId = projectId ?? previousChat?.currentProjectId ?? this.singleConfiguredProject()?.id;
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
      logEventType?: 'session.created' | 'session.resumed' | 'session.auto_started_single_project';
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
    const previousChat = await this.store.getChat(input.chatId);
    const chat: ChatContext = {
      chatId: input.chatId,
      chatType: input.chatType,
      currentProjectId: project.id,
      currentSessionId: sessionId,
      modelSelectionsByProject: previousChat?.modelSelectionsByProject,
    };
    await this.store.saveChat(chat);
    this.logger.info(options.logEventType ?? options.eventType, {
      chat: input.chatId,
      project: project.id,
      session: sessionId,
    });
    if (options.discoverCodexSessionId) {
      void this.discoverAndStoreCodexSessionId(sessionId, project.path, startedAt).catch((error) =>
        this.recordBackgroundError('session.codex_id_discovery_failed', error, { sessionId, projectPath: project.path }).catch(() => undefined),
      );
    }

    return { reply: `${options.replyVerb} session ${sessionId} for project ${project.id}.` };
  }

  private codexSessionRegistry(): CodexSessionDiscovery {
    return this.deps.codexSessionRegistry ?? new CodexSessionRegistry(this.defaultCodexHome());
  }

  private modelCatalog(): ModelCatalogReader {
    return this.deps.modelCatalog ?? { read: () => readCodexModelCatalog({ codexHome: this.defaultCodexHome() }) };
  }

  private defaultCodexHome(): string {
    return process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`;
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
    let chat = await this.store.getChat(input.chatId);
    if (!chat?.currentSessionId) {
      const autoStarted = await this.autoStartSingleProjectSession(input);
      if (autoStarted) {
        return autoStarted;
      }
      chat = await this.store.getChat(input.chatId);
    }
    if (!chat?.currentSessionId) {
      return { reply: 'No active session. Run /projects and /new <project> first.' };
    }
    const session = await this.store.getSession(chat.currentSessionId);
    if (!session || session.status !== 'running') {
      return { reply: 'No running session. Run /new <project> first.' };
    }

    const notificationEnabled = this.notificationsEnabled();
    const notificationStartedAt = new Date().toISOString();
    let createdPendingTurn = false;
    let followUpToActiveTurn = false;
    if (notificationEnabled) {
      if (this.pendingTurns.has(chat.currentSessionId)) {
        followUpToActiveTurn = true;
      } else {
        const turn = this.createPendingTurn(chat.currentSessionId, input.chatId, session.projectId, text, notificationStartedAt);
        await this.activatePendingTurn(turn);
        createdPendingTurn = true;
      }
    }

    const sendRequestedAt = new Date().toISOString();
    await this.store.appendEvent({
      type: 'session.send_requested',
      at: sendRequestedAt,
      data: {
        sessionId: chat.currentSessionId,
        chatId: input.chatId,
        projectId: session.projectId,
        textLength: text.length,
        textPreview: previewText(text),
        notificationsEnabled: notificationEnabled,
        pendingTurnId: this.pendingTurns.get(chat.currentSessionId)?.id,
        transportTerminator: JSON.stringify(PTY_SEND_TERMINATOR).slice(1, -1),
      },
    });
    if (notificationEnabled && followUpToActiveTurn) {
      await this.store.appendEvent({
        type: 'session.input_follow_up',
        at: sendRequestedAt,
        data: {
          sessionId: chat.currentSessionId,
          chatId: input.chatId,
          projectId: session.projectId,
          textLength: text.length,
          textPreview: previewText(text),
          pendingTurnId: this.pendingTurns.get(chat.currentSessionId)?.id,
        },
      }).catch((error) =>
        this.recordBackgroundError('session.input_follow_up_persist_failed', error, {
          sessionId: chat.currentSessionId,
          chatId: input.chatId,
          projectId: session.projectId,
        }).catch(() => undefined),
      );
    }

    try {
      await this.runner.send(chat.currentSessionId, text);
    } catch (error) {
      if (createdPendingTurn) {
        this.removePendingTurn(chat.currentSessionId, text, false);
      }
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
      this.logger.error('session.send_failed', {
        chat: input.chatId,
        session: chat.currentSessionId,
        reason: message,
      });
      return { reply: 'No running session. Run /new <project> first.' };
    }
    await this.store.appendEvent({
      type: 'session.send_dispatched',
      at: new Date().toISOString(),
      data: {
        sessionId: chat.currentSessionId,
        chatId: input.chatId,
        projectId: session.projectId,
        textLength: text.length,
        textPreview: previewText(text),
        notificationsEnabled: notificationEnabled,
        pendingTurnId: this.pendingTurns.get(chat.currentSessionId)?.id,
        transportTerminator: JSON.stringify(PTY_SEND_TERMINATOR).slice(1, -1),
      },
    });
    if (notificationEnabled && createdPendingTurn) {
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
    }
    if (notificationEnabled) {
      if (followUpToActiveTurn) {
        return { reply: this.isDebugUi() ? `补充消息已发送给 Codex。\nsession: ${chat.currentSessionId}` : '' };
      }
      if (createdPendingTurn && this.deps.sendConfirmation) {
        const confirmation = await this.confirmCodexStartedProcessing(chat.currentSessionId);
        if (!confirmation.confirmed) {
          return { reply: this.isDebugUi() ? `消息已写入会话，但 3 秒内尚未确认 Codex 开始处理。可稍后用 /tail 查看。\nsession: ${chat.currentSessionId}` : '' };
        }
      }
      return { reply: this.isDebugUi() ? `已发送给 Codex，完成后我会主动通知你。\nsession: ${chat.currentSessionId}` : '' };
    }
    await this.store.appendEvent({
      type: 'session.input',
      at: new Date().toISOString(),
      data: { sessionId: chat.currentSessionId },
    });
    return { reply: `Sent to Codex session ${chat.currentSessionId}.` };
  }

  private async autoStartSingleProjectSession(input: IncomingBotText): Promise<BotTextResult | undefined> {
    const project = this.singleConfiguredProject();
    if (!project) {
      return undefined;
    }

    const result = await this.startCodexSession(input, project, {
      mode: { kind: 'new' },
      replyVerb: 'Created',
      eventType: 'session.created',
      logEventType: 'session.auto_started_single_project',
      discoverCodexSessionId: true,
    });
    const chat = await this.store.getChat(input.chatId);
    return chat?.currentSessionId ? undefined : result;
  }

  private singleConfiguredProject(): NonNullable<ReturnType<typeof resolveProject>> | undefined {
    return this.config.projects.length === 1 ? this.config.projects[0] : undefined;
  }

  private async status(chatId: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    const session = chat?.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
    const pendingApprovals = await this.store.listPendingApprovalsByChat(chatId);
    const codexStatus = await this.codexStatusResult(session);
    const installedCliVersion = await this.runner.getVersion?.().catch(() => undefined);
    const message = formatStatusMessage({
      session: {
        projectId: chat?.currentProjectId,
        sessionId: chat?.currentSessionId,
        status: session?.status ?? 'none',
        summary: session?.lastSummary,
        pendingApprovals: pendingApprovals.map((approval) => approval.id),
      },
      codex: codexStatus,
      runtime: {
        installedCliVersion,
      },
    });

    return {
      reply: message.fallbackText,
      renderedReply: renderFeishuMessage(
        {
          kind: 'reply',
          bodyMarkdown: message.bodyMarkdown,
          fallbackText: message.fallbackText,
        },
        { verbosity: this.uiVerbosity() },
      ),
    };
  }

  private async model(chatId: string, args: string[]): Promise<BotTextResult> {
    if (args.length > 2) {
      return { reply: 'Usage: /model [model] [reasoning]' };
    }

    const catalog = await this.modelCatalog().read();
    if (catalog.kind === 'unavailable') {
      return { reply: catalog.message };
    }

    if (args.length === 0) {
      return { reply: await this.formatModelCatalog(chatId, catalog) };
    }

    const requestedSlug = args[0];
    const requestedReasoning = args[1];
    const selected = catalog.models.find((model) => model.slug === requestedSlug);
    if (!selected) {
      return { reply: `Unknown model: ${requestedSlug}\nAvailable models: ${formatModelSlugs(catalog.models)}` };
    }

    if (requestedReasoning && !selected.supportedReasoningLevels.includes(requestedReasoning)) {
      return {
        reply: `Unsupported reasoning level: ${requestedReasoning}\nSupported reasoning levels: ${formatReasoningLevels(selected)}`,
      };
    }

    const chat = await this.store.getChat(chatId);
    if (!chat?.currentProjectId) {
      return { reply: 'No project selected. Run /use <project> or /new <project> first.' };
    }

    const savedModelText = requestedReasoning ? `${selected.slug} ${requestedReasoning}` : selected.slug;
    await this.store.saveChat({
      ...chat,
      modelSelectionsByProject: {
        ...chat.modelSelectionsByProject,
        [chat.currentProjectId]: {
          model: selected.slug,
          reasoningEffort: requestedReasoning,
          updatedAt: new Date().toISOString(),
        },
      },
    });

    const runningSession = chat.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
    const lines = [`Saved default model: ${savedModelText}`];
    if (!runningSession || !isActiveSession(runningSession)) {
      lines.push('No running Codex session. The next /new or /resume will use this model.');
      return { reply: lines.join('\n') };
    }

    const nativeCommand = requestedReasoning ? `/model ${selected.slug} ${requestedReasoning}` : `/model ${selected.slug}`;
    try {
      await this.runner.send(runningSession.id, nativeCommand);
      lines.push('Sent runtime switch to current Codex session. Use /status to confirm the observed model.');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`Runtime switch failed: ${message}`);
    }
    return { reply: lines.join('\n') };
  }

  private async formatModelCatalog(chatId: string, catalog: Extract<CodexModelCatalog, { kind: 'available' }>): Promise<string> {
    const chat = await this.store.getChat(chatId);
    const session = chat?.currentSessionId ? await this.store.getSession(chat.currentSessionId) : undefined;
    const currentModel = await this.currentCodexModel(session);
    const savedDefault = chat?.currentProjectId ? chat.modelSelectionsByProject?.[chat.currentProjectId] : undefined;
    const lines = ['Codex models'];

    if (catalog.clientVersion) {
      lines.push(`Client: ${catalog.clientVersion}`);
    }
    if (catalog.fetchedAt) {
      lines.push(`Fetched: ${catalog.fetchedAt}`);
    }
    if (currentModel?.model) {
      lines.push(`Current: ${currentModel.model}`);
      if (currentModel.reasoningEffort) {
        lines.push(`Reasoning: ${currentModel.reasoningEffort}`);
      }
    }
    if (savedDefault) {
      lines.push(`Saved default: ${savedDefault.model}`);
      if (savedDefault.reasoningEffort) {
        lines.push(`Saved reasoning: ${savedDefault.reasoningEffort}`);
      }
    }

    lines.push('Available:');
    for (const model of catalog.models) {
      lines.push(formatModelLine(model));
    }
    return lines.join('\n');
  }

  private async currentCodexModel(session: SessionRecord | undefined): Promise<{ model?: string; reasoningEffort?: string } | undefined> {
    const codexStatus = await this.codexStatusResult(session);
    if (codexStatus.kind !== 'available') {
      return undefined;
    }
    const { model, reasoningEffort } = codexStatus.status.summary;
    if (!model && !reasoningEffort) {
      return undefined;
    }
    return { model, reasoningEffort };
  }

  private uiVerbosity(): 'normal' | 'debug' {
    return this.config.ui.verbosity;
  }

  private isDebugUi(): boolean {
    return this.uiVerbosity() === 'debug';
  }

  private decorateRenderedReply(rawInputText: string, result: BotTextResult): BotTextResult {
    if (result.reply === '' || result.renderedReply) {
      return result;
    }

    const parsed = parseIncomingText(rawInputText);
    if (parsed.kind === 'command' && (parsed.name === 'tail' || parsed.name === 'rawtail')) {
      return result;
    }

    return {
      ...result,
      renderedReply: renderFeishuMessage(
        {
          kind: 'reply',
          bodyMarkdown: result.reply,
          fallbackText: result.reply,
        },
        { verbosity: this.uiVerbosity() },
      ),
    };
  }

  private completionBotMessage(projectId: string, sessionId: string, extraction: FinalAnswerExtraction): BotMessage {
    if (extraction.kind === 'answer') {
      return {
        kind: 'completion',
        bodyMarkdown: extraction.text,
        fallbackText: extraction.text,
      };
    }

    const text = formatCompletionNotification({
      projectId,
      sessionId,
      extraction,
      verbosity: this.uiVerbosity(),
    });

    return {
      kind: 'error',
      bodyMarkdown: text,
      fallbackText: text,
    };
  }

  private async tail(chatId: string, requestedCount?: string): Promise<BotTextResult> {
    const chat = await this.store.getChat(chatId);
    if (!chat?.currentSessionId) {
      return { reply: 'No active session.' };
    }
    if (this.parseTailCount(requestedCount) === undefined) {
      return { reply: 'Invalid tail count.' };
    }

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

    const count = this.parseTailCount(requestedCount);
    if (count === undefined) {
      return { reply: 'Invalid tail count.' };
    }

    return { lines: await this.store.tailSessionLog(chat.currentSessionId, count) };
  }

  private parseTailCount(requestedCount?: string): number | undefined {
    if (requestedCount === undefined) {
      return 80;
    }
    if (!/^[1-9]\d*$/.test(requestedCount)) {
      return undefined;
    }
    return Number.parseInt(requestedCount, 10);
  }

  private codexObservationStore(): CodexObservationStore {
    return this.observationStore;
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
    return this.executeApprovedStop(session.id, input.userId);
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
    this.logger.info('session.stopped', {
      chat: initialSession.chatId,
      session: sessionId,
      user: userId,
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
    await this.flushPendingPtyDebugOutput(sessionId);
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
    this.logger.info('session.exited', {
      session: sessionId,
      exitCode: exitCode ?? 'none',
      status: updated?.status ?? 'missing',
    });
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
    await this.logPtyDebugOutput(sessionId, text);
    this.notifyLiveStatusWaiters(sessionId, text);
    await this.observePendingTurnOutput(sessionId);
  }

  private async codexStatusResult(session: SessionRecord | undefined): Promise<CodexStatusLookupResult> {
    if (!session) {
      return { kind: 'unavailable' };
    }

    if (session.status === 'running' || session.status === 'starting') {
      const result = await this.codexStatusService.fetchForRunningSession({
        sessionId: session.id,
        codexSessionId: session.codexSessionId,
        cached: session.codexStatus,
      });
      if (result.kind === 'available' && result.status.source === 'live') {
        await this.store.updateSession(session.id, (current) => ({
          ...current,
          codexStatus: result.status,
          updatedAt: new Date().toISOString(),
        }));
      }
      return this.cachedCodexStatusResult(result);
    }

    if (session.codexStatus) {
      return {
        kind: 'available',
        status: {
          ...session.codexStatus,
          source: 'cached',
        },
      };
    }

    return { kind: 'unavailable' };
  }

  private cachedCodexStatusResult(result: CodexStatusLookupResult): CodexStatusLookupResult {
    if (result.kind !== 'available' || result.status.source !== 'live') {
      return result;
    }
    return result;
  }

  private async fetchLiveCodexStatusText(sessionId: string, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) {
      throw new Error('Codex status fetch aborted');
    }

    return new Promise<string | undefined>(async (resolve, reject) => {
      const waiters = this.liveStatusWaiters.get(sessionId) ?? new Set<LiveStatusWaiter>();
      this.liveStatusWaiters.set(sessionId, waiters);

      const cleanup = (waiter: LiveStatusWaiter): void => {
        if (waiter.quietTimer) {
          clearTimeout(waiter.quietTimer);
        }
        signal.removeEventListener('abort', waiter.abortHandler);
        waiters.delete(waiter);
        if (waiters.size === 0) {
          this.liveStatusWaiters.delete(sessionId);
        }
      };

      const waiter: LiveStatusWaiter = {
        chunks: [],
        resolve: (text) => {
          cleanup(waiter);
          resolve(text);
        },
        reject: (reason) => {
          cleanup(waiter);
          reject(reason);
        },
        abortHandler: () => {
          cleanup(waiter);
          reject(new Error('Codex status fetch aborted'));
        },
      };

      waiters.add(waiter);
      signal.addEventListener('abort', waiter.abortHandler, { once: true });

      try {
        await this.runner.send(sessionId, 'status');
      } catch (error) {
        waiter.reject(error);
      }
    });
  }

  private notifyLiveStatusWaiters(sessionId: string, text: string): void {
    const waiters = this.liveStatusWaiters.get(sessionId);
    if (!waiters || waiters.size === 0) {
      return;
    }

    for (const waiter of waiters) {
      waiter.chunks.push(text);
      if (waiter.quietTimer) {
        clearTimeout(waiter.quietTimer);
      }
      waiter.quietTimer = setTimeout(() => {
        const formatted = this.formatLiveStatusChunks(waiter.chunks);
        if (!formatted) {
          return;
        }
        waiter.resolve(formatted);
      }, this.deps.codexStatus?.quietMs ?? DEFAULT_CODEX_STATUS_QUIET_MS);
    }
  }

  private formatLiveStatusChunks(chunks: string[]): string | undefined {
    const sanitized = sanitizeTerminalOutput(chunks);
    const readableLines = sanitized.readableLines
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.toLowerCase() !== 'status');
    const text = readableLines.join('\n').trim();
    return text || undefined;
  }

  private async logPtyDebugOutput(sessionId: string, text: string): Promise<void> {
    if (this.logger.level !== 'debug' || text.length === 0) {
      return;
    }
    const buffered = `${this.ptyDebugBuffers.get(sessionId) ?? ''}${text}`;
    const segments = buffered.split(/\r?\n/);
    const remainder = segments.pop() ?? '';
    this.ptyDebugBuffers.set(sessionId, remainder);
    for (const segment of segments) {
      await this.emitPtyDebugSegment(sessionId, segment);
    }
  }

  private async flushPendingPtyDebugOutput(sessionId: string): Promise<void> {
    if (this.logger.level !== 'debug') {
      this.ptyDebugBuffers.delete(sessionId);
      return;
    }
    const remainder = this.ptyDebugBuffers.get(sessionId);
    this.ptyDebugBuffers.delete(sessionId);
    if (!remainder) {
      return;
    }
    await this.emitPtyDebugSegment(sessionId, remainder);
  }

  private async emitPtyDebugSegment(sessionId: string, segment: string): Promise<void> {
    const sanitized = sanitizeTerminalOutput([segment]);
    const readableLines = sanitized.readableLines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (readableLines.length === 0) {
      return;
    }
    const session = await this.store.getSession(sessionId);
    for (const line of readableLines) {
      this.logger.debug('session.pty', {
        session: sessionId,
        chat: session?.chatId ?? 'unknown',
        project: session?.projectId ?? 'unknown',
        text: line,
      });
    }
  }

  private async observePendingTurnOutput(sessionId: string): Promise<void> {
    const turn = this.pendingTurns.get(sessionId);
    if (!turn || turn.notified) {
      return;
    }
    const pendingLines = await this.pendingTurnLogLines(sessionId, turn);
    const candidate = await this.currentTurnAnswerExtraction(sessionId, turn, { allowDiscovery: false });
    if (candidate.kind !== 'answer') {
      if (turn.timer) {
        clearTimeout(turn.timer);
        turn.timer = undefined;
      }
      turn.lastCandidate = undefined;
      return;
    }
    if (turn.lastCandidate === candidate.text) {
      return;
    }
    turn.lastCandidate = candidate.text;
    turn.candidateUpdateCount += 1;
    if (turn.timer) {
      clearTimeout(turn.timer);
    }
    await this.store.appendEvent({
      type: 'notification.answer_candidate_updated',
      at: new Date().toISOString(),
      data: {
        sessionId,
        chatId: turn.chatId,
        candidatePreview: previewCandidate(candidate.text),
        candidateHash: hashCandidate(candidate.text),
        source: candidate.source,
        requireCompletionMarker: true,
      },
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
      const currentAnswer = await this.currentTurnAnswerExtraction(sessionId, turn, { allowDiscovery: true });
      const extraction: FinalAnswerExtraction =
        currentAnswer.kind === 'answer' ? { kind: 'answer', text: currentAnswer.text } : { kind: 'empty', reason: 'No structured final answer detected.' };
      if (extraction.kind === 'answer' && currentAnswer.kind === 'answer') {
        void this.store.appendEvent({
          type: 'notification.final_extract_selected',
          at: new Date().toISOString(),
          data: {
            sessionId,
            chatId: turn.chatId,
            projectId: turn.projectId,
            candidatePreview: previewCandidate(extraction.text),
            candidateHash: hashCandidate(extraction.text),
            completionReason: reason,
            source: currentAnswer.source,
          },
        }).catch((error) =>
          this.recordBackgroundError('notification.final_extract_selected_persist_failed', error, {
            sessionId,
            chatId: turn.chatId,
            projectId: turn.projectId,
          }).catch(() => undefined),
        );
      } else {
        const emptyExtraction = extraction.kind === 'empty' ? extraction : { kind: 'empty' as const, reason: 'No structured final answer detected.' };
        void this.store.appendEvent({
          type: 'notification.final_extract_empty',
          at: new Date().toISOString(),
          data: {
            sessionId,
            chatId: turn.chatId,
            projectId: turn.projectId,
            completionReason: reason,
            reason: emptyExtraction.reason,
          },
        }).catch((error) =>
          this.recordBackgroundError('notification.final_extract_empty_persist_failed', error, {
            sessionId,
            chatId: turn.chatId,
            projectId: turn.projectId,
          }).catch(() => undefined),
        );
      }
      const message = this.completionBotMessage(turn.projectId, sessionId, extraction);
      const rendered = renderFeishuMessage(message, { verbosity: this.uiVerbosity() });
      if (this.deps.notifier!.sendRenderedMessage) {
        await this.deps.notifier!.sendRenderedMessage(turn.chatId, rendered);
      } else {
        await this.deps.notifier!.sendText(
          turn.chatId,
          rendered.fallback.kind === 'text' ? rendered.fallback.text : message.fallbackText,
        );
      }
      this.logger.info('notification.sent', {
        chat: turn.chatId,
        session: sessionId,
        project: turn.projectId,
        reason,
      });
      await this.store.appendEvent({
        type: reason === 'exit' ? 'notification.turn_exit_fallback' : 'notification.turn_completed',
        at: new Date().toISOString(),
        data: {
          sessionId,
          chatId: turn.chatId,
          projectId: turn.projectId,
          extraction: extraction.kind,
          candidateUpdateCount: turn.candidateUpdateCount,
          completionReason: reason,
        },
      }).catch((error) =>
        this.recordBackgroundError('notification.turn_completed_persist_failed', error, {
          sessionId,
          chatId: turn.chatId,
          projectId: turn.projectId,
        }).catch(() => undefined),
      );
    } catch (error) {
      this.logger.error('notification.failed', {
        chat: turn.chatId,
        session: sessionId,
        project: turn.projectId,
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      if (turn.timer) {
        clearTimeout(turn.timer);
      }
      this.pendingTurns.delete(sessionId);
      await this.activateNextQueuedTurn(sessionId);
    }
  }

  private async currentTurnObservationExtraction(
    sessionId: string,
    turn: PendingTurn,
    options: { allowDiscovery: boolean },
  ): Promise<{ kind: 'answer'; text: string } | undefined> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return undefined;
    }

    const codexSessionId = session.codexSessionId ?? (options.allowDiscovery ? await this.discoverCodexSessionIdForSession(session) : undefined);
    if (!codexSessionId) {
      return undefined;
    }

    const snapshot = await this.codexObservationStore().readSnapshot({ codexSessionId }).catch(() => undefined);
    if (!snapshot || (snapshot.availability.kind !== 'ready' && snapshot.availability.kind !== 'stale')) {
      return undefined;
    }

    const finalAnswer = snapshot.finalAnswer?.trim();
    if (!finalAnswer || !this.isObservationCurrentTurn(snapshot.completedAt, turn.startedAt)) {
      return undefined;
    }

    const extraction = extractFinalAnswer({
      rawLines: finalAnswer.split('\n'),
      prompt: turn.prompt,
      maxChars: this.config.notifications.maxFinalChars,
      requireCompletionMarker: false,
    });
    return extraction.kind === 'answer' ? extraction : undefined;
  }

  private async currentTurnAnswerExtraction(
    sessionId: string,
    turn: PendingTurn,
    options: { allowDiscovery: boolean },
  ): Promise<CurrentTurnAnswer> {
    const observationAnswer = await this.currentTurnObservationExtraction(sessionId, turn, options);
    if (observationAnswer) {
      return { kind: 'answer', text: observationAnswer.text, source: 'observation' };
    }

    const session = await this.store.getSession(sessionId);
    if (!session?.codexSessionId) {
      const ptyAnswer = await this.currentTurnPtyExtraction(sessionId, turn);
      if (ptyAnswer) {
        return { kind: 'answer', text: ptyAnswer, source: 'pty' };
      }
    }

    return { kind: 'empty' };
  }

  private async currentTurnPtyExtraction(sessionId: string, turn: PendingTurn): Promise<string | undefined> {
    const pendingLines = await this.pendingTurnLogLines(sessionId, turn);
    const extraction = extractFinalAnswer({
      rawLines: pendingLines,
      prompt: turn.prompt,
      maxChars: this.config.notifications.maxFinalChars,
      requireCompletionMarker: false,
    });
    return extraction.kind === 'answer' ? extraction.text : undefined;
  }

  private isObservationCurrentTurn(completedAt: string | undefined, startedAt: string): boolean {
    if (!completedAt) {
      return false;
    }
    const completedAtMs = Date.parse(completedAt);
    const startedAtMs = Date.parse(startedAt);
    if (Number.isNaN(completedAtMs) || Number.isNaN(startedAtMs)) {
      return false;
    }
    return completedAtMs >= startedAtMs;
  }

  private async discoverCodexSessionIdForSession(session: SessionRecord): Promise<string | undefined> {
    const project = resolveProject(this.config, session.projectId);
    if (!project) {
      return undefined;
    }
    return this.discoverAndStoreCodexSessionId(session.id, project.path, session.createdAt);
  }

  private async confirmCodexStartedProcessing(sessionId: string): Promise<SendConfirmationResult> {
    const turn = this.pendingTurns.get(sessionId);
    if (!turn || turn.notified) {
      return { confirmed: false, retryUsed: false };
    }

    const initialWaitMs = Math.max(0, this.deps.sendConfirmation?.initialWaitMs ?? DEFAULT_SEND_CONFIRMATION_INITIAL_WAIT_MS);
    const retryWaitMs = Math.max(0, this.deps.sendConfirmation?.retryWaitMs ?? DEFAULT_SEND_CONFIRMATION_RETRY_WAIT_MS);
    if (await this.waitForTurnProcessingEvidence(sessionId, turn, initialWaitMs)) {
      turn.processingState = 'confirmed_processing';
      await this.recordProcessingConfirmationEvent('session.processing_confirmed', turn, sessionId, false);
      return { confirmed: true, retryUsed: false };
    }
    if (!(await this.retryTurnSubmission(sessionId, turn))) {
      turn.processingState = 'unconfirmed_failed';
      await this.recordProcessingConfirmationEvent('session.processing_unconfirmed', turn, sessionId, false);
      return { confirmed: false, retryUsed: false };
    }
    if (await this.waitForTurnProcessingEvidence(sessionId, turn, retryWaitMs)) {
      turn.processingState = 'confirmed_processing';
      await this.recordProcessingConfirmationEvent('session.processing_confirmed', turn, sessionId, true);
      return { confirmed: true, retryUsed: true };
    }

    turn.processingState = 'unconfirmed_failed';
    await this.recordProcessingConfirmationEvent('session.processing_unconfirmed', turn, sessionId, true);
    return { confirmed: false, retryUsed: true };
  }

  private async retryTurnSubmission(sessionId: string, turn: PendingTurn): Promise<boolean> {
    if (turn.submitRetryCount >= SEND_SUBMIT_RETRY_LIMIT) {
      return false;
    }
    turn.submitRetryCount += 1;
    turn.processingState = 'submit_retry_sent';
    await this.store.appendEvent({
      type: 'session.send_submit_retry',
      at: new Date().toISOString(),
      data: {
        sessionId,
        chatId: turn.chatId,
        projectId: turn.projectId,
        retryCount: turn.submitRetryCount,
      },
    });
    try {
      await this.runner.send(sessionId, '');
      return true;
    } catch (error) {
      await this.recordBackgroundError('session.send_submit_retry_failed', error, {
        sessionId,
        chatId: turn.chatId,
        projectId: turn.projectId,
      });
      return false;
    }
  }

  private async recordProcessingConfirmationEvent(
    type: 'session.processing_confirmed' | 'session.processing_unconfirmed',
    turn: PendingTurn,
    sessionId: string,
    retryUsed: boolean,
  ): Promise<void> {
    await this.store.appendEvent({
      type,
      at: new Date().toISOString(),
      data: { sessionId, chatId: turn.chatId, projectId: turn.projectId, retryUsed },
    }).catch((error) =>
      this.recordBackgroundError(`${type}_persist_failed`, error, {
        sessionId,
        chatId: turn.chatId,
        projectId: turn.projectId,
      }).catch(() => undefined),
    );
  }

  private async waitForTurnProcessingEvidence(sessionId: string, turn: PendingTurn, timeoutMs: number): Promise<boolean> {
    const pollIntervalMs = Math.max(1, this.deps.sendConfirmation?.pollIntervalMs ?? DEFAULT_SEND_CONFIRMATION_POLL_INTERVAL_MS);
    const deadline = Date.now() + timeoutMs;
    do {
      if (await this.hasObservationTurnProcessingEvidence(sessionId, turn)) {
        return true;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      await this.sendConfirmationSleep(Math.min(pollIntervalMs, remainingMs));
    } while (Date.now() <= deadline);
    return this.hasObservationTurnProcessingEvidence(sessionId, turn);
  }

  private async sendConfirmationSleep(ms: number): Promise<void> {
    const sleep = this.deps.sendConfirmation?.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
    await sleep(ms);
  }

  private async hasObservationTurnProcessingEvidence(sessionId: string, turn: PendingTurn): Promise<boolean> {
    const session = await this.store.getSession(sessionId);
    if (!session) {
      return false;
    }
    const codexSessionId = session.codexSessionId ?? (await this.discoverCodexSessionIdForSession(session));
    if (!codexSessionId) {
      return false;
    }

    const snapshot = await this.codexObservationStore().readSnapshot({ codexSessionId }).catch(() => undefined);
    if (!snapshot || (snapshot.availability.kind !== 'ready' && snapshot.availability.kind !== 'stale')) {
      return false;
    }

    const startedAtMs = Date.parse(turn.startedAt);
    if (Number.isNaN(startedAtMs)) {
      return false;
    }
    const latestActivityAtMs = snapshot.latestActivityAt ? Date.parse(snapshot.latestActivityAt) : Number.NaN;
    const hasCurrentActivity = !Number.isNaN(latestActivityAtMs) && latestActivityAtMs >= startedAtMs;
    if (snapshot.completedAt && this.isObservationCurrentTurn(snapshot.completedAt, turn.startedAt)) {
      return true;
    }
    if (!hasCurrentActivity) {
      return false;
    }
    return Boolean(snapshot.latestCommentary?.trim() || snapshot.finalAnswer?.trim() || snapshot.recentToolEvents.length > 0);
  }

  private async pendingTurnLogLines(sessionId: string, turn: PendingTurn): Promise<string[]> {
    if (turn.outputStartOffset !== undefined) {
      return this.store.sessionLogLinesFrom(sessionId, turn.outputStartOffset);
    }
    const lines = await this.store.tailSessionLog(sessionId, 100000);
    return lines.slice(turn.outputStartIndex);
  }

  private createPendingTurn(sessionId: string, chatId: string, projectId: string, prompt: string, startedAt: string): PendingTurn {
    return {
      id: `${sessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      sessionId,
      chatId,
      projectId,
      prompt,
      startedAt,
      notified: false,
      candidateUpdateCount: 0,
      submitRetryCount: 0,
      processingState: 'pending_confirmation',
    };
  }

  private async activatePendingTurn(turn: PendingTurn): Promise<void> {
    turn.startedAt = new Date().toISOString();
    turn.outputStartIndex = (await this.store.tailSessionLog(turn.sessionId, 100000)).length;
    turn.outputStartOffset = await this.store.sessionLogSize(turn.sessionId);
    this.pendingTurns.set(turn.sessionId, turn);
  }

  private async activateNextQueuedTurn(sessionId: string): Promise<void> {
    const queue = this.queuedTurns.get(sessionId);
    if (!queue || queue.length === 0) {
      this.queuedTurns.delete(sessionId);
      return;
    }
    const next = queue.shift();
    if (!next) {
      this.queuedTurns.delete(sessionId);
      return;
    }
    if (queue.length === 0) {
      this.queuedTurns.delete(sessionId);
    } else {
      this.queuedTurns.set(sessionId, queue);
    }
    await this.activatePendingTurn(next);
    await this.store.appendEvent({
      type: 'notification.turn_started',
      at: new Date().toISOString(),
      data: { sessionId, chatId: next.chatId, projectId: next.projectId, pendingTurnId: next.id, source: 'queued' },
    }).catch((error) =>
      this.recordBackgroundError('notification.turn_started_persist_failed', error, {
        sessionId,
        chatId: next.chatId,
        projectId: next.projectId,
      }).catch(() => undefined),
    );
  }

  private removePendingTurn(sessionId: string, prompt: string, queuedTurn: boolean): void {
    if (queuedTurn) {
      const queue = this.queuedTurns.get(sessionId);
      if (!queue) {
        return;
      }
      const index = queue.findIndex((turn) => turn.prompt === prompt);
      if (index >= 0) {
        queue.splice(index, 1);
      }
      if (queue.length === 0) {
        this.queuedTurns.delete(sessionId);
      } else {
        this.queuedTurns.set(sessionId, queue);
      }
      return;
    }
    this.pendingTurns.delete(sessionId);
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
      '/help\n/projects\n/use <project>\n/new [project]\n/resume <session> [project]\n/send <text>\n/status\n/model [model] [reasoning]\n/tail [n]\n/rawtail [n]\n/stop\n/sessions\n/approve <id>\n/reject <id>';
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

function formatModelLine(model: CodexModelInfo): string {
  const details = [
    model.defaultReasoningLevel ? `default reasoning: ${model.defaultReasoningLevel}` : undefined,
    `supported reasoning: ${formatReasoningLevels(model)}`,
  ].filter((detail): detail is string => Boolean(detail));
  return `- ${model.slug} (${model.displayName})${details.length > 0 ? ` - ${details.join('; ')}` : ''}`;
}

function formatModelSlugs(models: CodexModelInfo[]): string {
  return models.map((model) => model.slug).join(', ') || 'none';
}

function formatReasoningLevels(model: CodexModelInfo): string {
  return model.supportedReasoningLevels.join(', ') || 'none';
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

function previewText(text: string): string {
  return text.length <= SEND_TEXT_PREVIEW_LIMIT ? text : `${text.slice(0, SEND_TEXT_PREVIEW_LIMIT - 3)}...`;
}

function previewCandidate(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= SEND_TEXT_PREVIEW_LIMIT ? singleLine : `${singleLine.slice(0, SEND_TEXT_PREVIEW_LIMIT - 3)}...`;
}

function hashCandidate(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 12);
}
