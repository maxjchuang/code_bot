import type { LogLevel } from '../logging/AppLogger.js';

export type ChatType = 'private' | 'group';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'interrupted' | 'unknown';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  codexArgs: string[];
}

export interface NotificationConfig {
  enabled: boolean;
  idleMs: number;
  maxFinalChars: number;
  failureTailChars: number;
}

export interface BotConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
  restrictUsers: boolean;
  restrictChatIds: boolean;
  allowedUsers: string[];
  allowedChatIds: string[];
  projects: ProjectConfig[];
  output: {
    directMaxChars: number;
    chunkSize: number;
  };
  codex: {
    command: string;
    defaultArgs: string[];
  };
  logLevel: LogLevel;
  ui: {
    verbosity: 'normal' | 'debug';
  };
  notifications: NotificationConfig;
}

export interface ChatContext {
  chatId: string;
  chatType: ChatType;
  currentProjectId?: string;
  currentSessionId?: string;
}

export interface CachedCodexStatusSummary {
  statusLine?: string;
  currentTask?: string;
  progressHint?: string;
  contextWindow?: string;
  tokenUsage?: string;
  lastTokenUsage?: string;
  rateLimits?: string;
  resetTimes?: string;
  model?: string;
  cwd?: string;
}

export interface CachedCodexStatus {
  source: 'live' | 'cached' | 'observation_fallback';
  fetchedAt: string;
  rawText: string;
  summary: CachedCodexStatusSummary;
}

export interface SessionRecord {
  id: string;
  chatId: string;
  projectId: string;
  status: SessionStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  pid?: number;
  logPath: string;
  exitCode?: number;
  lastSummary?: string;
  stopRequested?: boolean;
  codexSessionId?: string;
  resumedFromSessionId?: string;
  resumeSource?: 'code_bot' | 'codex';
  codexStatus?: CachedCodexStatus;
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  chatId: string;
  requestedBy: string;
  action?: 'stop_session';
  status: ApprovalStatus;
  riskSummary: string;
  createdAt: string;
  expiresAt: string;
  resolvedBy?: string;
  resolvedAt?: string;
}

export interface BotEvent {
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface BotErrorLogEntry {
  at: string;
  source: string;
  message: string;
  data: Record<string, unknown>;
}
