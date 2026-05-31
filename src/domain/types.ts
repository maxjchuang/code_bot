export type ChatType = 'private' | 'group';
export type SessionStatus = 'starting' | 'running' | 'exited' | 'interrupted' | 'unknown';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  codexArgs: string[];
}

export interface BotConfig {
  feishu: {
    appId: string;
    appSecret: string;
  };
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
}

export interface ChatContext {
  chatId: string;
  chatType: ChatType;
  currentProjectId?: string;
  currentSessionId?: string;
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
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  chatId: string;
  requestedBy: string;
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
