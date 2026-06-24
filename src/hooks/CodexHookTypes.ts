export type CodexHookEventName = 'session_started' | 'user_prompt_submitted' | 'stop';

export interface CodexHookStatusReport {
  configured: boolean;
  configFeatureEnabled: boolean;
  hooksJsonValid: boolean;
  hooksJsonContainsManagedHooks: boolean;
  manifestValid: boolean;
  scriptInstalled: boolean;
  listenerRunning?: boolean;
  recommendedCommand: '/install-hooks' | '/hook-status';
  issues: string[];
}

export interface CodexHookInstallResult {
  installed: boolean;
  status: CodexHookStatusReport;
}

export interface CodexHookUninstallResult {
  uninstalled: boolean;
  status: CodexHookStatusReport;
}

export type CodexHookHandleResult = { ok: true } | { ok: false; reason: string };
