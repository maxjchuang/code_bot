import { describe, expect, it, vi } from 'vitest';
import { FakeCodexObservationStore } from '../helpers/fakes.js';
import { createCodexStatusService } from '../../src/status/CodexStatusService.js';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('createCodexStatusService', () => {
  it('reuses one in-flight live fetch per session', async () => {
    const observationStore = new FakeCodexObservationStore();
    const liveFetch = deferred<string>();
    const fetchLiveStatusText = vi.fn().mockReturnValue(liveFetch.promise);
    const service = createCodexStatusService({
      fetchLiveStatusText,
      observationStore,
      now: () => new Date('2026-06-03T08:00:00.000Z'),
      timeoutMs: 100,
    });

    const first = service.fetchForRunningSession({
      sessionId: 'sess_1',
      codexSessionId: 'codex_1',
      cached: undefined,
    });
    const second = service.fetchForRunningSession({
      sessionId: 'sess_1',
      codexSessionId: 'codex_1',
      cached: undefined,
    });

    liveFetch.resolve('Status: running\nTask: Implement status integration');
    const [a, b] = await Promise.all([first, second]);

    expect(a.kind).toBe('available');
    expect(b).toEqual(a);
    expect(fetchLiveStatusText).toHaveBeenCalledTimes(1);
  });

  it('falls back to cached status after timeout', async () => {
    const observationStore = new FakeCodexObservationStore();
    const fetchLiveStatusText = vi.fn().mockImplementation(({ signal }: { signal: AbortSignal }) => {
      return new Promise<string>((_, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    });
    const service = createCodexStatusService({
      fetchLiveStatusText,
      observationStore,
      now: () => new Date('2026-06-03T08:00:00.000Z'),
      timeoutMs: 1,
    });

    const result = await service.fetchForRunningSession({
      sessionId: 'sess_1',
      codexSessionId: 'codex_1',
      cached: {
        source: 'live',
        fetchedAt: '2026-06-03T07:59:00.000Z',
        rawText: 'Status: running',
        summary: { statusLine: 'running' },
      },
    });

    expect(result).toEqual({
      kind: 'available',
      status: {
        source: 'cached',
        fetchedAt: '2026-06-03T07:59:00.000Z',
        rawText: 'Status: running',
        summary: { statusLine: 'running' },
      },
    });
  });

  it('uses observation fallback when live and cache are unavailable', async () => {
    const observationStore = new FakeCodexObservationStore();
    observationStore.snapshots.set('codex_1', {
      availability: { kind: 'ready' },
      codexSessionId: 'codex_1',
      status: 'running',
      latestActivityAt: '2026-06-03T08:00:00.000Z',
      latestCommentary: 'Implementing tests',
      recentToolEvents: [],
    });

    const service = createCodexStatusService({
      fetchLiveStatusText: vi.fn().mockResolvedValue(undefined),
      observationStore,
      now: () => new Date('2026-06-03T08:00:00.000Z'),
      timeoutMs: 1,
    });

    const result = await service.fetchForRunningSession({
      sessionId: 'sess_1',
      codexSessionId: 'codex_1',
      cached: undefined,
    });

    expect(result.kind).toBe('available');
    if (result.kind === 'available') {
      expect(result.status.source).toBe('observation_fallback');
      expect(result.status.summary.statusLine).toBe('running');
      expect(result.status.summary.progressHint).toBe('Implementing tests');
    }
  });
});
