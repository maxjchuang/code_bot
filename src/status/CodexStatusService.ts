import type { CachedCodexStatus } from '../domain/types.js';
import type { CodexObservationStore } from '../observations/CodexObservationStore.js';
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
    try {
      const liveText = await fetchLiveStatusWithTimeout(input.sessionId);
      if (liveText) {
        return {
          kind: 'available',
          status: {
            source: 'live',
            fetchedAt: now().toISOString(),
            rawText: liveText,
            summary: parseCodexStatusText(liveText),
          },
        };
      }
    } catch {
      // Fall through to cached and observation fallback.
    }

    if (input.cached) {
      return { kind: 'available', status: { ...input.cached, source: 'cached' } };
    }

    if (!input.codexSessionId) {
      return { kind: 'unavailable' };
    }

    const observation = await deps.observationStore.readSnapshot({ codexSessionId: input.codexSessionId });
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
        summary: {
          statusLine: observation.status,
          progressHint: observation.latestCommentary,
        },
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
