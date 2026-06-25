import type { BotConfig, ProjectConfig, SessionRecord } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';
import { createCodexSessionId, type CodexRestartEvent, type CodexRunner } from '../codex/CodexRunner.js';
import { CodexSessionRegistry } from '../codex/CodexSessionRegistry.js';
import { SessionManager, type CodexSessionDiscovery, type Notifier } from '../session/SessionManager.js';
import type { CodexObservationStore } from '../observations/CodexObservationStore.js';
import { resolveProject } from '../security/guards.js';
import { UpgradeManager } from '../upgrade/UpgradeManager.js';
import { applyCodexSessionEvent } from '../session/CodexSessionStateMachine.js';
import { CodexHookInstaller } from '../hooks/CodexHookInstaller.js';
import { CodexHookService } from '../hooks/CodexHookService.js';

export interface AppDependencies {
  projectRoot: string;
  config: BotConfig;
  store: FileStateStore;
  codexRunner: CodexRunner;
  notifier?: Notifier;
  codexSessionRegistry?: CodexSessionDiscovery;
  codexSessionDiscovery?: StartupCodexSessionDiscoveryOptions;
  codexObservationStore?: CodexObservationStore;
  codexHookInstaller?: Pick<CodexHookInstaller, 'status' | 'install' | 'uninstall'>;
  createCodexHookService?: (options: ConstructorParameters<typeof CodexHookService>[0]) => Pick<CodexHookService, 'start' | 'stop' | 'isRunning' | 'resolvePermissionRequest'>;
}

export function createApp(deps: AppDependencies): {
  sessionManager: SessionManager;
  healthCheck: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  recoverStartupState: () => Promise<void>;
} {
  const hookSocketPath = resolveHookSocketPath(deps.projectRoot, deps.config.codexHooks.socketPath);
  const codexHookInstaller =
    deps.codexHookInstaller ??
    new CodexHookInstaller({
      codexHome: process.env.CODEX_HOME ?? `${process.env.HOME ?? ''}/.codex`,
      projectRoot: deps.projectRoot,
      socketPath: hookSocketPath,
    });
  let sessionManager: SessionManager;
  const hookServiceOptions: ConstructorParameters<typeof CodexHookService>[0] = {
    enabled: deps.config.codexHooks.enabled,
    socketPath: hookSocketPath,
    store: deps.store,
    projects: deps.config.projects,
    permissionTimeoutMs: deps.config.codexHooks.permissionTimeoutMs,
    onPermissionRequest: (request) => sessionManager.handleHookPermissionRequest(request),
    onPermissionTimeout: (request) => sessionManager.handleHookPermissionTimeout(request),
  };
  const codexHookService = deps.createCodexHookService ? deps.createCodexHookService(hookServiceOptions) : new CodexHookService(hookServiceOptions);
  sessionManager = new SessionManager(deps.config, deps.store, deps.codexRunner, {
    logLevel: deps.config.logLevel,
    notifier: deps.notifier,
    codexSessionRegistry: deps.codexSessionRegistry,
    codexSessionDiscovery: deps.codexSessionDiscovery,
    codexObservationStore: deps.codexObservationStore,
    upgradeManager: new UpgradeManager({ projectRoot: deps.projectRoot, config: deps.config.upgrade }),
    codexHookInstaller,
    codexHookService,
    sendConfirmation: deps.notifier ? { initialWaitMs: 3_000, retryWaitMs: 2_000, pollIntervalMs: 100 } : undefined,
  });
  void codexHookService.start().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    void deps.store.appendEvent({
      type: 'hook.listener_start_failed',
      at: new Date().toISOString(),
      data: { reason: message },
    });
  });
  void recordStartupHookHealth(deps.config, deps.store, codexHookInstaller).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    void deps.store.appendEvent({
      type: 'hook.startup_status_failed',
      at: new Date().toISOString(),
      data: { reason: message },
    });
  });
  return {
    sessionManager,
    healthCheck: () => deps.codexRunner.healthCheck(),
    recoverStartupState: async () => {
      await recoverPendingApprovals(deps.store);
      await recoverStartupState(deps.store, deps.config, deps.codexRunner, {
        onOutput: (sessionId, text) => sessionManager.handleRunnerOutput(sessionId, text),
        onRestart: (sessionId, event) => sessionManager.handleRunnerRestart(sessionId, event),
        codexSessionRegistry: deps.codexSessionRegistry,
        codexSessionDiscovery: deps.codexSessionDiscovery,
      });
    },
  };
}

async function recoverPendingApprovals(store: FileStateStore): Promise<void> {
  const now = new Date().toISOString();
  for (const approval of await store.listPendingApprovals()) {
    await store.saveApproval({
      ...approval,
      status: 'expired',
      failureReason: 'Bot restarted before permission decision.',
    });
    await store.appendEvent({
      type: 'approval.expired_startup_recovery',
      at: now,
      data: { approvalId: approval.id, hookRequestId: approval.hookRequestId },
    });
  }
}

async function recordStartupHookHealth(
  config: BotConfig,
  store: FileStateStore,
  hookInstaller: Pick<CodexHookInstaller, 'status' | 'install'>,
): Promise<void> {
  if (!config.codexHooks.enabled) {
    return;
  }
  const status = await hookInstaller.status();
  const now = new Date().toISOString();
  await store.appendEvent({ type: 'hook.startup_status', at: now, data: status as unknown as Record<string, unknown> });
  if (!config.codexHooks.autoRepair || status.configured) {
    return;
  }
  await hookInstaller.install();
  await store.appendEvent({
    type: 'hook.auto_repaired',
    at: new Date().toISOString(),
    data: { reason: 'startup_status_unhealthy', recommendedCommand: status.recommendedCommand },
  });
}

function resolveHookSocketPath(projectRoot: string, socketPath: string): string {
  return socketPath.startsWith('/') ? socketPath : `${projectRoot}/${socketPath}`;
}

interface StartupCodexSessionDiscoveryOptions {
  maxAttempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface StartupRecoveryHooks {
  onOutput?(sessionId: string, text: string): Promise<void>;
  onRestart?(sessionId: string, event: CodexRestartEvent): Promise<void>;
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
      phase: 'interrupted' as const,
      lastSummary: session.lastSummary ?? 'Interrupted during bot restart recovery.',
      updatedAt: recoveredAt,
      lastActivityAt: recoveredAt,
      lastPhaseChangedAt: recoveredAt,
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

  const chats = await store.listChats();
  for (const chat of chats) {
    if (chat.currentSessionId) {
      const currentSession = recoveredSessions.get(chat.currentSessionId) ?? (await store.getSession(chat.currentSessionId));
      if (!currentSession || !isStartupRecoverableSession(currentSession, recoveredSessions.has(chat.currentSessionId))) {
        continue;
      }
      const resumedSessionId =
        config && codexRunner ? await autoResumeRecoveredSession(store, config, codexRunner, currentSession, hooks).catch(() => undefined) : undefined;
      const fallbackProject = config ? singleConfiguredProject(config) : undefined;
      const replacementSessionId =
        resumedSessionId ||
        (fallbackProject && codexRunner
          ? await autoStartSingleProjectSession(store, codexRunner, currentSession, fallbackProject, hooks).catch(() => undefined)
          : undefined);
      await store.saveChat({
        chatId: chat.chatId,
        chatType: chat.chatType,
        currentProjectId: replacementSessionId && fallbackProject ? fallbackProject.id : chat.currentProjectId,
        currentSessionId: replacementSessionId,
      });
    }
  }
}

function isStartupRecoverableSession(session: SessionRecord, recoveredThisStartup: boolean): boolean {
  if (recoveredThisStartup) {
    return true;
  }
  return session.status === 'interrupted' && Boolean(session.codexSessionId);
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
    phase: 'starting',
    createdBy: sourceSession.createdBy,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastPhaseChangedAt: now,
    logPath: store.sessionLogPath(sessionId),
    codexSessionId,
    resumedFromSessionId: sourceSession.id,
    resumeSource: 'code_bot',
    firstUserMessagePreview: sourceSession.firstUserMessagePreview,
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
      onRestart: (event) => {
        const persistRestart = hooks.onRestart
          ? hooks.onRestart(sessionId, event)
          : recordAutoResumedRunnerRestart(store, sessionId, event);
        void persistRestart.catch((error) =>
          recordAutoResumeBackgroundError(store, 'session.runner_restart_persist_failed', error, { sessionId, reason: event.reason }).catch(
            () => undefined,
          ),
        );
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date().toISOString();
    await store.saveSession({
      ...applyCodexSessionEvent(session, { type: 'runner.exited', sessionId, at: failedAt }),
      lastSummary: `Failed to auto-resume Codex session ${codexSessionId}: ${message}`,
    });
    await store.appendEvent({
      type: 'session.auto_resume_failed',
      at: failedAt,
      data: { sessionId, sourceSessionId: sourceSession.id, projectId: sourceSession.projectId, chatId: sourceSession.chatId, reason: message },
    });
    return undefined;
  }

  await store.saveSession(applyCodexSessionEvent(session, { type: 'runner.started', sessionId, at: new Date().toISOString() }));
  await store.appendEvent({
    type: 'session.auto_resumed',
    at: now,
    data: { sessionId, sourceSessionId: sourceSession.id, projectId: sourceSession.projectId, chatId: sourceSession.chatId },
  });
  return sessionId;
}

async function autoStartSingleProjectSession(
  store: FileStateStore,
  codexRunner: CodexRunner,
  sourceSession: SessionRecord,
  project: ProjectConfig,
  hooks: StartupRecoveryHooks,
): Promise<string | undefined> {
  const now = new Date().toISOString();
  const sessionId = createCodexSessionId();
  const session: SessionRecord = {
    id: sessionId,
    chatId: sourceSession.chatId,
    projectId: project.id,
    status: 'running',
    phase: 'starting',
    createdBy: sourceSession.createdBy,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastPhaseChangedAt: now,
    logPath: store.sessionLogPath(sessionId),
    lastSummary: `Auto-started fresh session for the only configured project ${project.id} after restart recovery.`,
  };
  await store.saveSession(session);

  try {
    await codexRunner.start({
      sessionId,
      cwd: project.path,
      args: project.codexArgs,
      mode: { kind: 'new' },
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
      onRestart: (event) => {
        const persistRestart = hooks.onRestart
          ? hooks.onRestart(sessionId, event)
          : recordAutoResumedRunnerRestart(store, sessionId, event);
        void persistRestart.catch((error) =>
          recordAutoResumeBackgroundError(store, 'session.runner_restart_persist_failed', error, { sessionId, reason: event.reason }).catch(
            () => undefined,
          ),
        );
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date().toISOString();
    await store.saveSession({
      ...applyCodexSessionEvent(session, { type: 'runner.exited', sessionId, at: failedAt }),
      lastSummary: `Failed to auto-start single-project fallback session for ${project.id}: ${message}`,
    });
    await store.appendEvent({
      type: 'session.auto_start_single_project_failed',
      at: failedAt,
      data: { sessionId, sourceSessionId: sourceSession.id, projectId: project.id, chatId: sourceSession.chatId, reason: message },
    });
    return undefined;
  }

  await store.saveSession(applyCodexSessionEvent(session, { type: 'runner.started', sessionId, at: new Date().toISOString() }));
  await store.appendEvent({
    type: 'session.auto_started_single_project',
    at: now,
    data: { sessionId, sourceSessionId: sourceSession.id, projectId: project.id, chatId: sourceSession.chatId },
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

function singleConfiguredProject(config: BotConfig): ProjectConfig | undefined {
  return config.projects.length === 1 ? config.projects[0] : undefined;
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

async function recordAutoResumedRunnerRestart(store: FileStateStore, sessionId: string, event: CodexRestartEvent): Promise<void> {
  await store.appendEvent({
    type: 'session.runner_restarted',
    at: new Date().toISOString(),
    data: { sessionId, reason: event.reason },
  });
}

async function recordAutoResumeBackgroundError(store: FileStateStore, type: string, error: unknown, data: Record<string, unknown>): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await store.appendEvent({
    type,
    at: new Date().toISOString(),
    data: { ...data, reason: message },
  });
}
