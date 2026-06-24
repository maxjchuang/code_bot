import { describe, expect, it } from 'vitest';
import { applyCodexSessionEvent } from '../../src/session/CodexSessionStateMachine.js';
import type { SessionRecord } from '../../src/domain/types.js';

function baseSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess_test',
    chatId: 'chat_1',
    projectId: 'proj_1',
    status: 'running',
    createdBy: 'user_1',
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
    logPath: '/tmp/session.log',
    ...overrides,
  };
}

describe('applyCodexSessionEvent', () => {
  it('moves a starting session to waiting_for_input when the runner starts', () => {
    const session = baseSession({ status: 'starting', phase: 'starting' });

    const updated = applyCodexSessionEvent(session, {
      type: 'runner.started',
      sessionId: 'sess_test',
      at: '2026-06-24T00:00:01.000Z',
      pid: 123,
    });

    expect(updated.phase).toBe('waiting_for_input');
    expect(updated.pid).toBe(123);
    expect(updated.lastActivityAt).toBe('2026-06-24T00:00:01.000Z');
    expect(updated.lastPhaseChangedAt).toBe('2026-06-24T00:00:01.000Z');
  });

  it('marks a session processing when a user message is submitted', () => {
    const session = baseSession({ phase: 'waiting_for_input' });

    const updated = applyCodexSessionEvent(session, {
      type: 'user.message_submitted',
      chatId: 'chat_1',
      userId: 'user_1',
      sessionId: 'sess_test',
      text: 'implement feature',
      at: '2026-06-24T00:00:02.000Z',
    });

    expect(updated.phase).toBe('processing');
    expect(updated.lastActivityAt).toBe('2026-06-24T00:00:02.000Z');
    expect(updated.lastPhaseChangedAt).toBe('2026-06-24T00:00:02.000Z');
  });

  it('keeps the previous phase timestamp when an event does not change phase', () => {
    const session = baseSession({
      phase: 'processing',
      lastPhaseChangedAt: '2026-06-24T00:00:02.000Z',
    });

    const updated = applyCodexSessionEvent(session, {
      type: 'runner.output_received',
      sessionId: 'sess_test',
      text: 'working',
      at: '2026-06-24T00:00:03.000Z',
    });

    expect(updated.phase).toBe('processing');
    expect(updated.lastActivityAt).toBe('2026-06-24T00:00:03.000Z');
    expect(updated.lastPhaseChangedAt).toBe('2026-06-24T00:00:02.000Z');
  });

  it('marks completion from observation without changing the coarse running status', () => {
    const session = baseSession({ status: 'running', phase: 'processing' });

    const updated = applyCodexSessionEvent(session, {
      type: 'observation.task_completed',
      sessionId: 'sess_test',
      codexSessionId: 'codex_1',
      finalAnswer: 'done',
      at: '2026-06-24T00:00:04.000Z',
    });

    expect(updated.status).toBe('running');
    expect(updated.phase).toBe('completed');
    expect(updated.lastSummary).toBe('done');
  });

  it('marks runner exit as exited and preserves exit code', () => {
    const session = baseSession({ status: 'running', phase: 'processing' });

    const updated = applyCodexSessionEvent(session, {
      type: 'runner.exited',
      sessionId: 'sess_test',
      exitCode: 0,
      at: '2026-06-24T00:00:05.000Z',
    });

    expect(updated.status).toBe('exited');
    expect(updated.phase).toBe('exited');
    expect(updated.exitCode).toBe(0);
  });
});
