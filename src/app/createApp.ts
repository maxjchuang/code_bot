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
} {
  return {
    sessionManager: new SessionManager(deps.config, deps.store, deps.codexRunner),
    healthCheck: () => deps.codexRunner.healthCheck(),
  };
}
