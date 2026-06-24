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
  it('returns the original session object unchanged when the sessionId does not match', () => {
    const session = baseSession({ phase: 'processing' });

    const updated = applyCodexSessionEvent(session, {
      type: 'runner.started',
      sessionId: 'other_session',
      at: '2026-06-24T00:00:01.000Z',
      pid: 123,
    });

    expect(updated).toBe(session);
  });

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

  it('records hook session id when a Codex hook session starts', () => {
    const session = baseSession({ phase: 'starting' });

    const updated = applyCodexSessionEvent(session, {
      type: 'hook.session_started',
      sessionId: 'sess_test',
      hookSessionId: 'codex_hook_1',
      cwd: '/repo',
      at: '2026-06-24T00:00:02.000Z',
    });

    expect(updated.codexHookSessionId).toBe('codex_hook_1');
    expect(updated.phase).toBe('starting');
  });

  it('marks a session processing when a user prompt hook is submitted', () => {
    const session = baseSession({ phase: 'waiting_for_input' });

    const updated = applyCodexSessionEvent(session, {
      type: 'hook.user_prompt_submitted',
      sessionId: 'sess_test',
      hookSessionId: 'codex_hook_1',
      cwd: '/repo',
      at: '2026-06-24T00:00:02.000Z',
    });

    expect(updated.phase).toBe('processing');
    expect(updated.codexHookSessionId).toBe('codex_hook_1');
  });

  it('marks a session ready for input when a stop hook is received', () => {
    const session = baseSession({ phase: 'processing' });

    const updated = applyCodexSessionEvent(session, {
      type: 'hook.stop',
      sessionId: 'sess_test',
      hookSessionId: 'codex_hook_1',
      at: '2026-06-24T00:00:02.000Z',
    });

    expect(updated.status).toBe('running');
    expect(updated.phase).toBe('waiting_for_input');
    expect(updated.codexHookSessionId).toBe('codex_hook_1');
  });

  it('allows task completion after a normal stop hook', () => {
    const session = baseSession({ phase: 'processing' });
    const stopped = applyCodexSessionEvent(session, {
      type: 'hook.stop',
      sessionId: 'sess_test',
      hookSessionId: 'codex_hook_1',
      at: '2026-06-24T00:00:02.000Z',
    });

    const completed = applyCodexSessionEvent(stopped, {
      type: 'observation.task_completed',
      sessionId: 'sess_test',
      codexSessionId: 'codex_1',
      finalAnswer: 'done',
      at: '2026-06-24T00:00:03.000Z',
    });

    expect(completed.phase).toBe('completed');
    expect(completed.lastSummary).toBe('done');
  });

  it('moves to waiting_for_approval when a permission hook is requested', () => {
    const session = baseSession({ phase: 'processing' });

    const updated = applyCodexSessionEvent(session, {
      type: 'hook.permission_requested',
      sessionId: 'sess_test',
      hookRequestId: 'hook_req_1',
      toolName: 'shell',
      toolInput: { command: 'npm install' },
      at: '2026-06-24T00:00:02.000Z',
    });

    expect(updated.phase).toBe('waiting_for_approval');
    expect(updated.lastPhaseChangedAt).toBe('2026-06-24T00:00:02.000Z');
  });

  it('moves back to processing when approval.approved is received', () => {
    const session = baseSession({ phase: 'waiting_for_approval' });

    const updated = applyCodexSessionEvent(session, {
      type: 'approval.approved',
      sessionId: 'sess_test',
      approvalId: 'appr_approved',
      hookRequestId: 'hook_req_1',
      userId: 'ou_1',
      at: '2026-06-24T00:00:03.000Z',
    });

    expect(updated.phase).toBe('processing');
    expect(updated.lastPhaseChangedAt).toBe('2026-06-24T00:00:03.000Z');
  });

  it('moves back to processing when approval.rejected is received', () => {
    const session = baseSession({ phase: 'waiting_for_approval' });

    const updated = applyCodexSessionEvent(session, {
      type: 'approval.rejected',
      sessionId: 'sess_test',
      approvalId: 'appr_rejected',
      hookRequestId: 'hook_req_1',
      userId: 'ou_1',
      at: '2026-06-24T00:00:03.000Z',
    });

    expect(updated.phase).toBe('processing');
    expect(updated.lastPhaseChangedAt).toBe('2026-06-24T00:00:03.000Z');
  });

  it('moves back to processing when approval.expired is received', () => {
    const session = baseSession({ phase: 'waiting_for_approval' });

    const updated = applyCodexSessionEvent(session, {
      type: 'approval.expired',
      sessionId: 'sess_test',
      approvalId: 'appr_expired',
      hookRequestId: 'hook_req_1',
      at: '2026-06-24T00:00:03.000Z',
    });

    expect(updated.phase).toBe('processing');
    expect(updated.lastPhaseChangedAt).toBe('2026-06-24T00:00:03.000Z');
  });

  it('preserves an existing firstUserMessagePreview when a user message is submitted', () => {
    const session = baseSession({
      phase: 'waiting_for_input',
      firstUserMessagePreview: 'existing preview',
    });

    const updated = applyCodexSessionEvent(session, {
      type: 'user.message_submitted',
      chatId: 'chat_1',
      userId: 'user_1',
      sessionId: 'sess_test',
      text: 'implement feature',
      at: '2026-06-24T00:00:02.000Z',
    });

    expect(updated.firstUserMessagePreview).toBe('existing preview');
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

  it('sets phase processing when runner output is received without a prior phase', () => {
    const session = baseSession({ phase: undefined });

    const updated = applyCodexSessionEvent(session, {
      type: 'runner.output_received',
      sessionId: 'sess_test',
      text: 'working',
      at: '2026-06-24T00:00:03.000Z',
    });

    expect(updated.phase).toBe('processing');
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

  it('does not reopen an exited session when a late runner starts', () => {
    const session = baseSession({ status: 'exited', phase: 'exited' });

    const updated = applyCodexSessionEvent(session, {
      type: 'runner.started',
      sessionId: 'sess_test',
      at: '2026-06-24T00:00:04.000Z',
      pid: 456,
    });

    expect(updated.status).toBe('exited');
    expect(updated.phase).toBe('exited');
    expect(updated.pid).toBeUndefined();
  });

  it('marks a recovered interrupted session as interrupted', () => {
    const session = baseSession({ status: 'running', phase: 'processing', lastSummary: undefined });

    const updated = applyCodexSessionEvent(session, {
      type: 'session.recovered_interrupted',
      sessionId: 'sess_test',
      at: '2026-06-24T00:00:04.000Z',
    });

    expect(updated.status).toBe('interrupted');
    expect(updated.phase).toBe('interrupted');
    expect(updated.lastSummary).toBe('Interrupted during bot restart recovery.');
  });

  it('does not reopen an interrupted session when a late auto-resume arrives', () => {
    const session = baseSession({ status: 'interrupted', phase: 'interrupted' });

    const updated = applyCodexSessionEvent(session, {
      type: 'session.auto_resumed',
      sessionId: 'sess_test',
      sourceSessionId: 'sess_prev',
      at: '2026-06-24T00:00:05.000Z',
    });

    expect(updated.status).toBe('interrupted');
    expect(updated.phase).toBe('interrupted');
  });

  it('does not overwrite an exited session when a late task completion arrives', () => {
    const session = baseSession({ status: 'exited', phase: 'exited', lastSummary: 'stopped' });

    const updated = applyCodexSessionEvent(session, {
      type: 'observation.task_completed',
      sessionId: 'sess_test',
      codexSessionId: 'codex_1',
      finalAnswer: 'done',
      at: '2026-06-24T00:00:06.000Z',
    });

    expect(updated.status).toBe('exited');
    expect(updated.phase).toBe('exited');
    expect(updated.lastSummary).toBe('stopped');
  });

  it('marks an auto-resumed session as waiting_for_input', () => {
    const session = baseSession({ status: 'running', phase: 'processing' });

    const updated = applyCodexSessionEvent(session, {
      type: 'session.auto_resumed',
      sessionId: 'sess_test',
      sourceSessionId: 'sess_prev',
      at: '2026-06-24T00:00:05.000Z',
    });

    expect(updated.status).toBe('running');
    expect(updated.phase).toBe('waiting_for_input');
  });

  it('moves a completed session to exited when the runner exits', () => {
    const session = baseSession({ status: 'running', phase: 'completed' });

    const updated = applyCodexSessionEvent(session, {
      type: 'runner.exited',
      sessionId: 'sess_test',
      exitCode: 0,
      at: '2026-06-24T00:00:06.000Z',
    });

    expect(updated.status).toBe('exited');
    expect(updated.phase).toBe('exited');
    expect(updated.exitCode).toBe(0);
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
