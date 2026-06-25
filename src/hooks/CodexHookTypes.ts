export type CodexHookEventName = 'session_started' | 'user_prompt_submitted' | 'stop' | 'permission_request';

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

export interface CodexPermissionRequest {
  sessionId: string;
  hookRequestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export type CodexPermissionDecision = { decision: 'allow' } | { decision: 'deny'; reason?: string } | { decision: 'timeout' };
