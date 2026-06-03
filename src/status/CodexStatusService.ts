import type { CachedCodexStatus } from '../domain/types.js';
import type { CodexObservationSnapshot, CodexObservationStore } from '../observations/CodexObservationStore.js';
import { parseCodexStatusText } from './CodexStatusParser.js';

export type CodexStatusLookupResult =
  | { kind: 'available'; status: CachedCodexStatus }
  | { kind: 'unavailable' };

export function createCodexStatusService(deps: {
  fetchLiveStatusText: (input: { sessionId: string; signal: AbortSignal }) => Promise<string | undefined>;
  observationStore: CodexObservationStore;
  now?: () => Date;
  timeoutMs?: number;
}) {
  const now = deps.now ?? (() => new Date());
  const timeoutMs = deps.timeoutMs ?? 2_000;
  const inFlight = new Map<string, Promise<CodexStatusLookupResult>>();

  async function fetchForRunningSession(input: {
    sessionId: string;
    codexSessionId?: string;
    cached?: CachedCodexStatus;
  }): Promise<CodexStatusLookupResult> {
    const existing = inFlight.get(input.sessionId);
    if (existing) {
      return existing;
    }

    const current = lookupRunningSessionStatus(input).finally(() => {
      inFlight.delete(input.sessionId);
    });
    inFlight.set(input.sessionId, current);
    return current;
  }

  async function lookupRunningSessionStatus(input: {
    sessionId: string;
    codexSessionId?: string;
    cached?: CachedCodexStatus;
  }): Promise<CodexStatusLookupResult> {
    const observation =
      input.codexSessionId
        ? await deps.observationStore.readSnapshot({ codexSessionId: input.codexSessionId }).catch(() => undefined)
        : undefined;

    try {
      const liveText = await fetchLiveStatusWithTimeout(input.sessionId);
      if (liveText) {
        const summary = enrichSummary(parseCodexStatusText(liveText), observation);
        return {
          kind: 'available',
          status: {
            source: 'live',
            fetchedAt: now().toISOString(),
            rawText: liveText,
            summary,
          },
        };
      }
    } catch {
      // Fall through to cached and observation fallback.
    }

    if (input.cached) {
      return {
        kind: 'available',
        status: {
          ...input.cached,
          source: 'cached',
          summary: enrichSummary(input.cached.summary, observation),
        },
      };
    }

    if (!observation) {
      return { kind: 'unavailable' };
    }

    if (observation.availability.kind !== 'ready' && observation.availability.kind !== 'stale') {
      return { kind: 'unavailable' };
    }

    const rawText = [observation.latestCommentary, observation.latestActivityAt ? `Latest activity: ${observation.latestActivityAt}` : undefined]
      .filter((line): line is string => Boolean(line))
      .join('\n');

    return {
      kind: 'available',
      status: {
        source: 'observation_fallback',
        fetchedAt: now().toISOString(),
        rawText,
        summary: enrichSummary(
          {
          statusLine: observation.status,
          progressHint: observation.latestCommentary,
          },
          observation,
        ),
      },
    };
  }

  async function fetchLiveStatusWithTimeout(sessionId: string): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await deps.fetchLiveStatusText({ sessionId, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  return { fetchForRunningSession };
}

function enrichSummary(
  summary: CachedCodexStatus['summary'],
  observation: CodexObservationSnapshot | undefined,
): CachedCodexStatus['summary'] {
  if (!observation) {
    return summary;
  }

  const next = { ...summary };
  const totalTokens = observation.tokenCount?.total;
  if (totalTokens) {
    next.tokenUsage = formatTokenUsage('total', totalTokens);
  }
  const lastTokens = observation.tokenCount?.last;
  if (lastTokens) {
    next.lastTokenUsage = formatTokenUsage('last', lastTokens);
  }
  if (observation.tokenCount?.modelContextWindow) {
    next.contextWindow = formatContextWindow(observation.tokenCount.modelContextWindow, totalTokens, lastTokens);
  }
  const rateLimits = formatRateLimits(observation);
  if (rateLimits) {
    next.rateLimits = rateLimits;
  }
  const resetTimes = formatResetTimes(observation);
  if (resetTimes) {
    next.resetTimes = resetTimes;
  }
  return next;
}

function formatTokenUsage(
  label: 'total' | 'last',
  usage: NonNullable<CodexObservationSnapshot['tokenCount']>['total'],
): string | undefined {
  if (!usage) {
    return undefined;
  }
  const parts = [`${label} ${usage.totalTokens ?? 0}`];
  if (usage.inputTokens !== undefined) {
    parts.push(`input ${usage.inputTokens}`);
  }
  if (usage.cachedInputTokens !== undefined) {
    parts.push(`cached ${usage.cachedInputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`output ${usage.outputTokens}`);
  }
  if (usage.reasoningOutputTokens !== undefined) {
    parts.push(`reasoning ${usage.reasoningOutputTokens}`);
  }
  return parts.join(' | ');
}

function formatContextWindow(
  totalWindow: number,
  totalUsage: NonNullable<CodexObservationSnapshot['tokenCount']>['total'],
  lastUsage: NonNullable<CodexObservationSnapshot['tokenCount']>['last'],
): string {
  const used = totalUsage?.totalTokens ?? lastUsage?.totalTokens;
  const parts = [`${totalWindow} total`];
  if (used !== undefined) {
    parts.push(`${Math.max(totalWindow - used, 0)} remaining`);
  }
  return parts.join(' | ');
}

function formatRateLimits(observation: CodexObservationSnapshot): string | undefined {
  const parts: string[] = [];
  if (observation.rateLimits?.primary?.usedPercent !== undefined) {
    parts.push(`primary ${observation.rateLimits.primary.usedPercent}% / ${observation.rateLimits.primary.windowMinutes ?? '?'}m`);
  }
  if (observation.rateLimits?.secondary?.usedPercent !== undefined) {
    parts.push(`secondary ${observation.rateLimits.secondary.usedPercent}% / ${observation.rateLimits.secondary.windowMinutes ?? '?'}m`);
  }
  if (observation.rateLimits?.planType) {
    parts.push(`plan ${observation.rateLimits.planType}`);
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

function formatResetTimes(observation: CodexObservationSnapshot): string | undefined {
  const parts: string[] = [];
  if (observation.rateLimits?.primary?.resetsAt) {
    parts.push(`primary ${observation.rateLimits.primary.resetsAt}`);
  }
  if (observation.rateLimits?.secondary?.resetsAt) {
    parts.push(`secondary ${observation.rateLimits.secondary.resetsAt}`);
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}
