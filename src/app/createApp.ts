import type { BotConfig } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';
import type { CodexRunner } from '../codex/CodexRunner.js';
import { SessionManager } from '../session/SessionManager.js';

export interface AppDependencies {
  projectRoot: string;
  config: BotConfig;
  store: FileStateStore;
  codexRunner: CodexRunner;
}

export function createApp(deps: AppDependencies): {
  sessionManager: SessionManager;
  healthCheck: () => Promise<{ ok: true } | { ok: false; reason: string }>;
  recoverStartupState: () => Promise<void>;
} {
  return {
    sessionManager: new SessionManager(deps.config, deps.store, deps.codexRunner),
    healthCheck: () => deps.codexRunner.healthCheck(),
    recoverStartupState: () => recoverStartupState(deps.store),
  };
}

export async function recoverStartupState(store: FileStateStore): Promise<void> {
  const sessions = await store.listSessions();
  const recoveredSessionIds = new Set<string>();

  for (const session of sessions) {
    if (session.status !== 'running' && session.status !== 'starting') {
      continue;
    }

    const recoveredAt = new Date().toISOString();
    recoveredSessionIds.add(session.id);
    await store.saveSession({
      ...session,
      status: 'interrupted',
      lastSummary: session.lastSummary ?? 'Interrupted during bot restart recovery.',
      updatedAt: recoveredAt,
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

  if (recoveredSessionIds.size === 0) {
    return;
  }

  const chats = await store.listChats();
  for (const chat of chats) {
    if (chat.currentSessionId && recoveredSessionIds.has(chat.currentSessionId)) {
      await store.saveChat({
        chatId: chat.chatId,
        chatType: chat.chatType,
        currentProjectId: chat.currentProjectId,
        currentSessionId: undefined,
      });
    }
  }
}
