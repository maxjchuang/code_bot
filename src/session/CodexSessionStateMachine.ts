import type { SessionRecord } from '../domain/types.js';
import type { CodexSessionEvent } from './CodexSessionEvents.js';

export function applyCodexSessionEvent(session: SessionRecord, event: CodexSessionEvent): SessionRecord {
  if (event.sessionId !== session.id) {
    return session;
  }

  if (isProtectedTerminalPhase(session.phase) && event.type !== 'runner.exited') {
    return session;
  }

  const next = reduceSession(session, event);
  const nextPhase = next.phase ?? session.phase;
  const phaseChanged = nextPhase !== session.phase;
  return {
    ...next,
    phase: nextPhase,
    updatedAt: event.at,
    lastActivityAt: event.at,
    lastPhaseChangedAt: phaseChanged ? event.at : session.lastPhaseChangedAt,
  };
}

function reduceSession(session: SessionRecord, event: CodexSessionEvent): SessionRecord {
  switch (event.type) {
    case 'runner.started':
      return {
        ...session,
        pid: event.pid ?? session.pid,
        status: 'running',
        phase: 'waiting_for_input',
      };
    case 'user.message_submitted':
      return {
        ...session,
        phase: 'processing',
        firstUserMessagePreview: session.firstUserMessagePreview ?? preview(event.text),
      };
    case 'runner.output_received':
      return session.phase ? session : { ...session, phase: 'processing' };
    case 'hook.session_started':
      return {
        ...session,
        codexHookSessionId: event.hookSessionId ?? session.codexHookSessionId,
      };
    case 'hook.user_prompt_submitted':
      return {
        ...session,
        phase: 'processing',
        codexHookSessionId: event.hookSessionId ?? session.codexHookSessionId,
      };
    case 'hook.stop':
      return {
        ...session,
        status: 'running',
        phase: 'waiting_for_input',
        codexHookSessionId: event.hookSessionId ?? session.codexHookSessionId,
      };
    case 'observation.task_completed':
      return {
        ...session,
        phase: 'completed',
        codexSessionId: event.codexSessionId,
        lastSummary: event.finalAnswer ?? session.lastSummary,
      };
    case 'runner.exited':
      return {
        ...session,
        status: 'exited',
        phase: 'exited',
        exitCode: event.exitCode,
      };
    case 'session.recovered_interrupted':
      return {
        ...session,
        status: 'interrupted',
        phase: 'interrupted',
        lastSummary: session.lastSummary ?? 'Interrupted during bot restart recovery.',
      };
    case 'session.auto_resumed':
      return {
        ...session,
        status: 'running',
        phase: 'waiting_for_input',
      };
    default:
      return assertNever(event);
  }
}

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117)}...` : normalized;
}

function isProtectedTerminalPhase(phase: SessionRecord['phase']): boolean {
  return phase === 'completed' || phase === 'exited' || phase === 'interrupted' || phase === 'failed';
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Codex session event: ${JSON.stringify(value)}`);
}
