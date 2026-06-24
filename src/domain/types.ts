import type { LogLevel } from '../logging/AppLogger.js';

export type ChatType = 'private' | 'group';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'interrupted' | 'unknown';
export type CodexSessionPhase =
  | 'idle'
  | 'starting'
  | 'processing'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'exited';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  codexArgs: string[];
}

export interface SavedModelSelection {
  model: string;
  reasoningEffort?: string;
  updatedAt: string;
}

export interface NotificationConfig {
  enabled: boolean;
  idleMs: number;
  maxFinalChars: number;
  failureTailChars: number;
}

export interface UpgradeConfig {
  enabled: boolean;
  adminUsers: string[];
  pm2ProcessName: string;
  remote: string;
  branch: string;
}

export interface CodexHooksConfig {
  enabled: boolean;
  autoRepair: boolean;
  socketPath: string;
  permissionTimeoutMs: number;
  adminUsers: string[];
}

export interface TerminalSnapshotConfig {
  cols: number;
  rows: number;
  scrollback: number;
  replayMaxBytes: number;
  cardMaxRows: number;
  cardMaxLineChars: number;
  maxStyledSegmentsPerLine: number;
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
    terminalSnapshot: TerminalSnapshotConfig;
  };
  codex: {
    command: string;
    defaultArgs: string[];
  };
  logLevel: LogLevel;
  ui: {
    verbosity: 'normal' | 'debug';
    currentRenderMode: 'markdown' | 'code';
    timeZone: string;
  };
  notifications: NotificationConfig;
  upgrade: UpgradeConfig;
  codexHooks: CodexHooksConfig;
}

export interface ChatContext {
  chatId: string;
  chatType: ChatType;
  currentProjectId?: string;
  currentSessionId?: string;
  modelSelectionsByProject?: Record<string, SavedModelSelection>;
}

export interface CachedCodexStatusSummary {
  statusLine?: string;
  currentTask?: string;
  progressHint?: string;
  cliVersion?: string;
  reasoningEffort?: string;
  summaryMode?: string;
  permissions?: string;
  collaborationMode?: string;
  contextWindow?: string;
  tokenUsage?: string;
  lastTokenUsage?: string;
  primaryLimit?: string;
  weeklyLimit?: string;
  planType?: string;
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
  phase?: CodexSessionPhase;
  createdBy: string;
  createdAt: string;
  lastActivityAt?: string;
  updatedAt: string;
  lastPhaseChangedAt?: string;
  pid?: number;
  logPath: string;
  exitCode?: number;
  lastSummary?: string;
  firstUserMessagePreview?: string;
  stopRequested?: boolean;
  codexSessionId?: string;
  codexHookSessionId?: string;
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

export interface InboundMessageReceipt {
  messageId: string;
  chatId: string;
  chatType: ChatType;
  userId: string;
  textPreview: string;
  firstReceivedAt: string;
  lastDuplicateAt?: string;
  duplicateCount: number;
  status: 'claimed';
}

export interface ClaimInboundMessageInput {
  messageId?: string;
  chatId: string;
  chatType: ChatType;
  userId: string;
  text: string;
}

export type ClaimInboundMessageResult =
  | { claimed: true; receipt: InboundMessageReceipt }
  | { claimed: true; reason: 'missing_message_id' }
  | { claimed: false; receipt: InboundMessageReceipt };

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
