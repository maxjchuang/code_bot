import type { BotConfig, SessionRecord } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';
import { createCodexSessionId, type CodexRunner } from '../codex/CodexRunner.js';
import { CodexSessionRegistry } from '../codex/CodexSessionRegistry.js';
import { SessionManager, type CodexSessionDiscovery, type Notifier } from '../session/SessionManager.js';
import type { CodexObservationStore } from '../observations/CodexObservationStore.js';
import { resolveProject } from '../security/guards.js';

export interface AppDependencies {
  projectRoot: string;
  config: BotConfig;
  store: FileStateStore;
  codexRunner: CodexRunner;
  notifier?: Notifier;
  codexSessionRegistry?: CodexSessionDiscovery;
  codexSessionDiscovery?: StartupCodexSessionDiscoveryOptions;
  codexObservationStore?: CodexObservationStore;
}

export function createApp(deps: AppDependencies): {
  sessionManager: SessionManager;
  healthCheck: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  recoverStartupState: () => Promise<void>;
} {
  const sessionManager = new SessionManager(deps.config, deps.store, deps.codexRunner, {
    notifier: deps.notifier,
    codexSessionRegistry: deps.codexSessionRegistry,
    codexSessionDiscovery: deps.codexSessionDiscovery,
    codexObservationStore: deps.codexObservationStore,
    sendConfirmation: deps.notifier ? { initialWaitMs: 3_000, retryWaitMs: 2_000, pollIntervalMs: 100 } : undefined,
  });
  return {
    sessionManager,
    healthCheck: () => deps.codexRunner.healthCheck(),
    recoverStartupState: () =>
      recoverStartupState(deps.store, deps.config, deps.codexRunner, {
        onOutput: (sessionId, text) => sessionManager.handleRunnerOutput(sessionId, text),
        codexSessionRegistry: deps.codexSessionRegistry,
        codexSessionDiscovery: deps.codexSessionDiscovery,
      }),
  };
}

interface StartupCodexSessionDiscoveryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface StartupRecoveryHooks {
  onOutput?(sessionId: string, text: string): Promise<void>;
  codexSessionRegistry?: CodexSessionDiscovery;
  codexSessionDiscovery?: StartupCodexSessionDiscoveryOptions;
}

const DEFAULT_STARTUP_CODEX_SESSION_DISCOVERY_MAX_ATTEMPTS = 3;
const DEFAULT_STARTUP_CODEX_SESSION_DISCOVERY_RETRY_DELAY_MS = 250;

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
  const codexSessionId = sourceSession.codexSessionId ?? (await discoverRecoveredCodexSessionId(store, config, sourceSession, hooks));
  if (!codexSessionId) {
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
    codexSessionId,
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
      mode: { kind: 'resume', target: codexSessionId },
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
      lastSummary: `Failed to auto-resume Codex session ${codexSessionId}: ${message}`,
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

async function discoverRecoveredCodexSessionId(
  store: FileStateStore,
  config: BotConfig,
  sourceSession: SessionRecord,
  hooks: StartupRecoveryHooks,
): Promise<string | undefined> {
  const project = resolveProject(config, sourceSession.projectId);
  if (!project) {
    return undefined;
  }

  const maxAttempts = Math.max(1, hooks.codexSessionDiscovery?.maxAttempts ?? DEFAULT_STARTUP_CODEX_SESSION_DISCOVERY_MAX_ATTEMPTS);
  const retryDelayMs = hooks.codexSessionDiscovery?.retryDelayMs ?? DEFAULT_STARTUP_CODEX_SESSION_DISCOVERY_RETRY_DELAY_MS;
  let lastFailureReason: 'not-found' | 'ambiguous' = 'not-found';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let result: Awaited<ReturnType<CodexSessionDiscovery['discoverForProject']>>;
    try {
      result = await codexSessionRegistry(hooks).discoverForProject({ projectPath: project.path, startedAt: sourceSession.createdAt });
    } catch (error) {
      await recordAutoResumeBackgroundError(store, 'session.codex_id_discovery_failed', error, {
        sessionId: sourceSession.id,
        projectPath: project.path,
      });
      return undefined;
    }

    if (result.ok) {
      const discoveredAt = new Date().toISOString();
      await store.updateSession(sourceSession.id, (latest) => ({
        ...latest,
        codexSessionId: result.codexSessionId,
        updatedAt: discoveredAt,
      }));
      await store.appendEvent({
        type: 'session.codex_id_discovered',
        at: discoveredAt,
        data: { sessionId: sourceSession.id, projectPath: project.path, codexSessionId: result.codexSessionId },
      });
      return result.codexSessionId;
    }

    lastFailureReason = result.reason;
    if (attempt < maxAttempts) {
      await startupCodexSessionDiscoverySleep(hooks, retryDelayMs);
    }
  }

  await store.appendEvent({
    type: 'session.codex_id_discovery_failed',
    at: new Date().toISOString(),
    data: { sessionId: sourceSession.id, projectPath: project.path, reason: lastFailureReason },
  });
  return undefined;
}

function codexSessionRegistry(hooks: StartupRecoveryHooks): CodexSessionDiscovery {
  return hooks.codexSessionRegistry ?? new CodexSessionRegistry(process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`);
}

async function startupCodexSessionDiscoverySleep(hooks: StartupRecoveryHooks, ms: number): Promise<void> {
  const sleep = hooks.codexSessionDiscovery?.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  await sleep(ms);
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
