import type { BotConfig, SessionRecord } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';
import { createCodexSessionId, type CodexRunner } from '../codex/CodexRunner.js';
import { SessionManager, type Notifier } from '../session/SessionManager.js';
import { resolveProject } from '../security/guards.js';

export interface AppDependencies {
  projectRoot: string;
  config: BotConfig;
  store: FileStateStore;
  codexRunner: CodexRunner;
  notifier?: Notifier;
}

export function createApp(deps: AppDependencies): {
  sessionManager: SessionManager;
  healthCheck: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  recoverStartupState: () => Promise<void>;
} {
  const sessionManager = new SessionManager(deps.config, deps.store, deps.codexRunner, { notifier: deps.notifier });
  return {
    sessionManager,
    healthCheck: () => deps.codexRunner.healthCheck(),
    recoverStartupState: () =>
      recoverStartupState(deps.store, deps.config, deps.codexRunner, {
        onOutput: (sessionId, text) => sessionManager.handleRunnerOutput(sessionId, text),
      }),
  };
}

interface StartupRecoveryHooks {
  onOutput?(sessionId: string, text: string): Promise<void>;
}

export async function recoverStartupState(
  store: FileStateStore,
  config?: BotConfig,
  codexRunner?: CodexRunner,
  hooks: StartupRecoveryHooks = {},
): Promise<void> {
  const sessions = await store.listSessions();
  const recoveredSessions = new Map<string, SessionRecord>();

  for (const session of sessions) {
    if (session.status !== 'running' && session.status !== 'starting') {
      continue;
    }

    const recoveredAt = new Date().toISOString();
    const recoveredSession = {
      ...session,
      status: 'interrupted' as const,
      lastSummary: session.lastSummary ?? 'Interrupted during bot restart recovery.',
      updatedAt: recoveredAt,
    };
    recoveredSessions.set(session.id, recoveredSession);
    await store.saveSession({
      ...recoveredSession,
    });
    await store.appendEvent({
      type: 'session.recovered_interrupted',
      at: recoveredAt,
      data: {
        sessionId: session.id,
        chatId: session.chatId,
        projectId: session.projectId,
        previousStatus: session.status,
      },
    });
  }

  if (recoveredSessions.size === 0) {
    return;
  }

  const chats = await store.listChats();
  for (const chat of chats) {
    if (chat.currentSessionId && recoveredSessions.has(chat.currentSessionId)) {
      const recoveredSession = recoveredSessions.get(chat.currentSessionId)!;
      const resumedSessionId =
        config && codexRunner ? await autoResumeRecoveredSession(store, config, codexRunner, recoveredSession, hooks).catch(() => undefined) : undefined;
      await store.saveChat({
        chatId: chat.chatId,
        chatType: chat.chatType,
        currentProjectId: chat.currentProjectId,
        currentSessionId: resumedSessionId,
      });
    }
  }
}

async function autoResumeRecoveredSession(
  store: FileStateStore,
  config: BotConfig,
  codexRunner: CodexRunner,
  sourceSession: SessionRecord,
  hooks: StartupRecoveryHooks,
): Promise<string | undefined> {
  if (!sourceSession.codexSessionId) {
    return undefined;
  }
  const project = resolveProject(config, sourceSession.projectId);
  if (!project) {
    return undefined;
  }

  const now = new Date().toISOString();
  const sessionId = createCodexSessionId();
  const session: SessionRecord = {
    id: sessionId,
    chatId: sourceSession.chatId,
    projectId: sourceSession.projectId,
    status: 'running',
    createdBy: sourceSession.createdBy,
    createdAt: now,
    updatedAt: now,
    logPath: store.sessionLogPath(sessionId),
    codexSessionId: sourceSession.codexSessionId,
    resumedFromSessionId: sourceSession.id,
    resumeSource: 'code_bot',
    lastSummary: 'Auto-resumed after bot restart.',
  };
  await store.saveSession(session);

  try {
    await codexRunner.start({
      sessionId,
      cwd: project.path,
      args: project.codexArgs,
      mode: { kind: 'resume', target: sourceSession.codexSessionId },
      onOutput: (text) => {
        const persistOutput = hooks.onOutput ? hooks.onOutput(sessionId, text) : store.appendSessionLog(sessionId, text);
        void persistOutput.catch((error) =>
          recordAutoResumeBackgroundError(store, 'session.output_persist_failed', error, { sessionId }).catch(() => undefined),
        );
      },
      onExit: (exitCode) => {
        void markAutoResumedExited(store, sessionId, exitCode).catch((error) =>
          recordAutoResumeBackgroundError(store, 'session.exit_persist_failed', error, { sessionId, exitCode }).catch(() => undefined),
        );
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date().toISOString();
    await store.saveSession({
      ...session,
      status: 'exited',
      updatedAt: failedAt,
      lastSummary: `Failed to auto-resume Codex session ${sourceSession.codexSessionId}: ${message}`,
    });
    await store.appendEvent({
      type: 'session.auto_resume_failed',
      at: failedAt,
      data: { sessionId, sourceSessionId: sourceSession.id, projectId: sourceSession.projectId, chatId: sourceSession.chatId, reason: message },
    });
    return undefined;
  }

  await store.appendEvent({
    type: 'session.auto_resumed',
    at: now,
    data: { sessionId, sourceSessionId: sourceSession.id, projectId: sourceSession.projectId, chatId: sourceSession.chatId },
  });
  return sessionId;
}

async function markAutoResumedExited(store: FileStateStore, sessionId: string, exitCode: number | undefined): Promise<void> {
  const exitedAt = new Date().toISOString();
  const session = await store.updateSession(sessionId, (latest) => ({
    ...latest,
    status: 'exited',
    exitCode,
    updatedAt: exitedAt,
  }));
  if (!session) {
    return;
  }
  const chat = await store.getChat(session.chatId);
  if (chat?.currentSessionId === sessionId) {
    await store.saveChat({
      chatId: chat.chatId,
      chatType: chat.chatType,
      currentProjectId: chat.currentProjectId,
      currentSessionId: undefined,
    });
  }
}

async function recordAutoResumeBackgroundError(store: FileStateStore, type: string, error: unknown, data: Record<string, unknown>): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await store.appendEvent({
    type,
    at: new Date().toISOString(),
    data: { ...data, reason: message },
  });
}
