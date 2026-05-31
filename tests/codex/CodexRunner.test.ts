import { describe, expect, it, vi } from 'vitest';
import { createCodexSessionId, PtyCodexRunner } from '../../src/codex/CodexRunner.js';

describe('CodexRunner helpers', () => {
  it('creates stable prefixed session ids', () => {
    expect(createCodexSessionId('abc123').startsWith('sess_abc123_')).toBe(true);
  });
});

describe('PtyCodexRunner', () => {
  it('reports missing codex command through health check', async () => {
    const runner = new PtyCodexRunner({ command: 'definitely-missing-codex-command', defaultArgs: [] });
    await expect(runner.healthCheck()).resolves.toEqual({ ok: false, reason: 'Command not found: definitely-missing-codex-command' });
  });

  it('can be constructed with codex command', () => {
    const runner = new PtyCodexRunner({ command: 'codex', defaultArgs: [] });
    expect(runner).toBeInstanceOf(PtyCodexRunner);
    vi.restoreAllMocks();
  });
});
