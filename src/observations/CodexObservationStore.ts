import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export type ObservationAvailability =
  | { kind: 'ready' }
  | { kind: 'not_found' }
  | { kind: 'not_yet_flushed' }
  | { kind: 'stale' }
  | { kind: 'parse_error'; reason: string };

export type CodexObservationSnapshot = {
  availability: ObservationAvailability;
  codexSessionId: string;
  status: 'running' | 'completed' | 'idle' | 'unknown';
  cwd?: string;
  cliVersion?: string;
  model?: string;
  reasoningEffort?: string;
  summaryMode?: string;
  permissions?: string;
  collaborationMode?: string;
  latestActivityAt?: string;
  latestCommentary?: string;
  finalAnswer?: string;
  completedAt?: string;
  tokenCount?: {
    total?: TokenUsageBreakdown;
    last?: TokenUsageBreakdown;
    modelContextWindow?: number;
  };
  rateLimits?: {
    primary?: ObservationRateLimitWindow;
    secondary?: ObservationRateLimitWindow;
    planType?: string;
  };
  recentToolEvents: Array<{
    kind: 'tool_call' | 'tool_output';
    toolName?: string;
    summary: string;
    at: string;
  }>;
};

type TokenUsageBreakdown = {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

type ObservationRateLimitWindow = {
  usedPercent?: number;
  windowMinutes?: number;
  resetsAt?: string;
};

export interface CodexObservationStore {
  readSnapshot(input: { codexSessionId: string }): Promise<CodexObservationSnapshot>;
}

export class FileCodexObservationStore implements CodexObservationStore {
  constructor(
    private readonly deps: {
      codexHome: string;
      staleAfterMs?: number;
      now?: () => Date;
    },
  ) {}

  async readSnapshot(input: { codexSessionId: string }): Promise<CodexObservationSnapshot> {
    const rolloutPath = await findRolloutPath(join(this.deps.codexHome, 'sessions'), input.codexSessionId);
    if (!rolloutPath) {
      return {
        availability: { kind: 'not_found' },
        codexSessionId: input.codexSessionId,
        status: 'unknown',
        recentToolEvents: [],
      };
    }

    let lines: string[];
    try {
      lines = (await readFile(rolloutPath, 'utf8')).split('\n').filter(Boolean);
    } catch (error) {
      return parseErrorSnapshot(input.codexSessionId, error);
    }

    const toolEvents: CodexObservationSnapshot['recentToolEvents'] = [];
    let latestCommentary: string | undefined;
    let finalAnswer: string | undefined;
    let completedAt: string | undefined;
    let latestActivityTimestamp: string | undefined;
    let status: CodexObservationSnapshot['status'] = 'unknown';
    let cwd: string | undefined;
    let cliVersion: string | undefined;
    let model: string | undefined;
    let reasoningEffort: string | undefined;
    let summaryMode: string | undefined;
    let permissions: string | undefined;
    let collaborationMode: string | undefined;
    let tokenCount: CodexObservationSnapshot['tokenCount'];
    let rateLimits: CodexObservationSnapshot['rateLimits'];

    try {
      for (const line of lines) {
        const event = JSON.parse(line) as { timestamp?: string; type?: string; payload?: any };
        const eventTimestamp = typeof event.timestamp === 'string' ? event.timestamp : undefined;
        if (event.type === 'session_meta') {
          cwd = typeof event.payload?.cwd === 'string' ? event.payload.cwd : cwd;
          cliVersion = typeof event.payload?.cli_version === 'string' ? event.payload.cli_version : cliVersion;
        }
        if (event.type === 'turn_context') {
          cwd = typeof event.payload?.cwd === 'string' ? event.payload.cwd : cwd;
          model = typeof event.payload?.model === 'string' ? event.payload.model : model;
          reasoningEffort =
            typeof event.payload?.reasoning_effort === 'string'
              ? event.payload.reasoning_effort
              : typeof event.payload?.effort === 'string'
                ? event.payload.effort
                : reasoningEffort;
          summaryMode = typeof event.payload?.summary === 'string' ? event.payload.summary : summaryMode;
          permissions = formatPermissions(event.payload?.approval_policy, event.payload?.sandbox_policy);
          collaborationMode =
            typeof event.payload?.collaboration_mode?.mode === 'string' ? event.payload.collaboration_mode.mode : collaborationMode;
        }
        if (event.type === 'event_msg' && event.payload?.type === 'task_started') {
          latestActivityTimestamp = eventTimestamp ?? latestActivityTimestamp;
          status = 'running';
          toolEvents.length = 0;
          latestCommentary = undefined;
          finalAnswer = undefined;
          completedAt = undefined;
        }
        if (event.type === 'event_msg' && event.payload?.type === 'agent_message' && event.payload?.phase === 'commentary') {
          latestActivityTimestamp = eventTimestamp ?? latestActivityTimestamp;
          latestCommentary = event.payload.message;
          status = 'running';
        }
        if (event.type === 'response_item' && event.payload?.type === 'message' && event.payload?.phase === 'final_answer') {
          latestActivityTimestamp = eventTimestamp ?? latestActivityTimestamp;
          finalAnswer = extractOutputText(event.payload.content);
        }
        if (event.type === 'event_msg' && event.payload?.type === 'task_complete') {
          latestActivityTimestamp = eventTimestamp ?? latestActivityTimestamp;
          status = 'completed';
          completedAt = normalizeCompletedAt(event.payload.completed_at) ?? event.timestamp;
          finalAnswer ??= event.payload.last_agent_message;
        }
        if (event.type === 'response_item' && event.payload?.type === 'function_call') {
          latestActivityTimestamp = eventTimestamp ?? latestActivityTimestamp;
          toolEvents.push({
            kind: 'tool_call',
            toolName: event.payload.name,
            summary: summarizeFunctionCall(event.payload.name, event.payload.arguments),
            at: event.timestamp ?? '',
          });
        }
        if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
          latestActivityTimestamp = eventTimestamp ?? latestActivityTimestamp;
          tokenCount = {
            total: normalizeTokenUsage(event.payload.info?.total_token_usage),
            last: normalizeTokenUsage(event.payload.info?.last_token_usage),
            modelContextWindow:
              typeof event.payload.info?.model_context_window === 'number' && Number.isFinite(event.payload.info.model_context_window)
                ? event.payload.info.model_context_window
                : undefined,
          };
          rateLimits = {
            primary: normalizeRateLimitWindow(event.payload.rate_limits?.primary),
            secondary: normalizeRateLimitWindow(event.payload.rate_limits?.secondary),
            planType: typeof event.payload.rate_limits?.plan_type === 'string' ? event.payload.rate_limits.plan_type : undefined,
          };
        }
      }
    } catch (error) {
      return parseErrorSnapshot(input.codexSessionId, error);
    }

    const availability = classifyAvailability(
      latestActivityTimestamp,
      this.deps.staleAfterMs ?? 15_000,
      this.deps.now ?? (() => new Date()),
    );
    return {
      availability,
      codexSessionId: input.codexSessionId,
      status,
      cwd,
      cliVersion,
      model,
      reasoningEffort,
      summaryMode,
      permissions,
      collaborationMode,
      latestActivityAt: latestActivityTimestamp,
      latestCommentary,
      finalAnswer,
      completedAt,
      tokenCount,
      rateLimits,
      recentToolEvents: toolEvents.slice(-5),
    };
  }
}

function normalizeTokenUsage(value: unknown): TokenUsageBreakdown | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const normalized: TokenUsageBreakdown = {
    inputTokens: finiteNumber(record.input_tokens),
    cachedInputTokens: finiteNumber(record.cached_input_tokens),
    outputTokens: finiteNumber(record.output_tokens),
    reasoningOutputTokens: finiteNumber(record.reasoning_output_tokens),
    totalTokens: finiteNumber(record.total_tokens),
  };
  return Object.values(normalized).some((field) => field !== undefined) ? normalized : undefined;
}

function normalizeRateLimitWindow(value: unknown): ObservationRateLimitWindow | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const normalized: ObservationRateLimitWindow = {
    usedPercent: finiteNumber(record.used_percent),
    windowMinutes: finiteNumber(record.window_minutes),
    resetsAt: normalizeResetTimestamp(record.resets_at),
  };
  return Object.values(normalized).some((field) => field !== undefined) ? normalized : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function normalizeResetTimestamp(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return undefined;
}

function formatPermissions(approvalPolicy: unknown, sandboxPolicy: unknown): string | undefined {
  if (approvalPolicy === 'never' && sandboxPolicy && typeof sandboxPolicy === 'object' && (sandboxPolicy as { type?: unknown }).type === 'danger-full-access') {
    return 'Full Access';
  }
  if (typeof approvalPolicy === 'string' || (sandboxPolicy && typeof sandboxPolicy === 'object' && typeof (sandboxPolicy as { type?: unknown }).type === 'string')) {
    const approval = typeof approvalPolicy === 'string' ? approvalPolicy : 'unknown';
    const sandbox = sandboxPolicy && typeof sandboxPolicy === 'object' && typeof (sandboxPolicy as { type?: unknown }).type === 'string'
      ? (sandboxPolicy as { type: string }).type
      : 'unknown';
    return `${approval} / ${sandbox}`;
  }
  return undefined;
}

function extractOutputText(content: unknown): string | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  return (
    content
      .flatMap((item) =>
        item && typeof item === 'object' && 'text' in item && typeof (item as { text?: unknown }).text === 'string'
          ? [(item as { text: string }).text]
          : [],
      )
      .join('\n')
      .trim() || undefined
  );
}

function summarizeFunctionCall(name: string | undefined, argumentsText: string | undefined): string {
  const parsed = parseJsonObject(argumentsText);
  const cmd = typeof parsed?.cmd === 'string' ? parsed.cmd : undefined;
  return cmd ? `${name ?? 'tool'}: ${cmd}` : `${name ?? 'tool'} invoked`;
}

function parseJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) {
    return undefined;
  }
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function findRolloutPath(dir: string, codexSessionId: string): Promise<string | undefined> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findRolloutPath(child, codexSessionId);
      if (nested) {
        return nested;
      }
      continue;
    }
    if (entry.isFile() && entry.name.includes(codexSessionId) && entry.name.endsWith('.jsonl')) {
      return child;
    }
  }
  return undefined;
}

function classifyAvailability(
  latestTimestamp: string | undefined,
  staleAfterMs: number,
  now: () => Date,
): ObservationAvailability {
  if (!latestTimestamp) {
    return { kind: 'not_yet_flushed' };
  }
  const latestMs = Date.parse(latestTimestamp);
  if (Number.isNaN(latestMs)) {
    return { kind: 'parse_error', reason: `Invalid timestamp: ${latestTimestamp}` };
  }
  if (now().getTime() - latestMs > staleAfterMs) {
    return { kind: 'stale' };
  }
  return { kind: 'ready' };
}

function normalizeCompletedAt(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  return undefined;
}

function parseErrorSnapshot(codexSessionId: string, error: unknown): CodexObservationSnapshot {
  return {
    availability: { kind: 'parse_error', reason: error instanceof Error ? error.message : String(error) },
    codexSessionId,
    status: 'unknown',
    recentToolEvents: [],
  };
}
