import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { FileCodexObservationStore } from '../../src/observations/CodexObservationStore.js';

async function createCodexHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'code-bot-observation-'));
}

async function writeRollout(codexHome: string, relativePath: string, lines: string[]): Promise<string> {
  const rolloutPath = join(codexHome, 'sessions', relativePath);
  await mkdir(join(rolloutPath, '..'), { recursive: true });
  await writeFile(rolloutPath, `${lines.join('\n')}\n`, 'utf8');
  return rolloutPath;
}

describe('FileCodexObservationStore', () => {
  it('extracts commentary, final answer, tool activity, and completion from a rollout file', async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, '2026/06/02/rollout-2026-06-02T15-00-00-019e86b4-12ed-7731-9639-c128626a328b.jsonl', [
      JSON.stringify({
        timestamp: '2026-06-02T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: '019e86b4-12ed-7731-9639-c128626a328b', cwd: '/repo', cli_version: '0.135.0' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1780387202 },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:00:03.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', phase: 'commentary', message: '我先检查当前实现，再决定如何切 observation。' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:00:04.000Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"rg -n \\"tail\\" src"}' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:00:04.500Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1200,
              cached_input_tokens: 800,
              output_tokens: 120,
              reasoning_output_tokens: 30,
              total_tokens: 1320,
            },
            last_token_usage: {
              input_tokens: 200,
              cached_input_tokens: 100,
              output_tokens: 20,
              reasoning_output_tokens: 5,
              total_tokens: 220,
            },
            model_context_window: 4096,
          },
          rate_limits: {
            primary: { used_percent: 14, window_minutes: 300, resets_at: 1780389000 },
            secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1780993800 },
            plan_type: 'prolite',
          },
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:00:05.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '最终建议：保留 PTY 控制面，新增 observation 主路径。' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:00:05.100Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: '最终建议：保留 PTY 控制面，新增 observation 主路径。',
          completed_at: 1780387205,
          duration_ms: 3100,
        },
      }),
    ]);

    const store = new FileCodexObservationStore({ codexHome, now: () => new Date('2026-06-02T08:00:06.000Z') });
    const snapshot = await store.readSnapshot({ codexSessionId: '019e86b4-12ed-7731-9639-c128626a328b' });

    expect(snapshot.availability.kind).toBe('ready');
    expect(snapshot.status).toBe('completed');
    expect(snapshot.latestCommentary).toBe('我先检查当前实现，再决定如何切 observation。');
    expect(snapshot.finalAnswer).toBe('最终建议：保留 PTY 控制面，新增 observation 主路径。');
    expect(snapshot.completedAt).toBe('2026-06-02T08:00:05.000Z');
    expect(snapshot.tokenCount).toEqual({
      total: {
        inputTokens: 1200,
        cachedInputTokens: 800,
        outputTokens: 120,
        reasoningOutputTokens: 30,
        totalTokens: 1320,
      },
      last: {
        inputTokens: 200,
        cachedInputTokens: 100,
        outputTokens: 20,
        reasoningOutputTokens: 5,
        totalTokens: 220,
      },
      modelContextWindow: 4096,
    });
    expect(snapshot.rateLimits).toEqual({
      primary: { usedPercent: 14, windowMinutes: 300, resetsAt: '2026-06-02T08:30:00.000Z' },
      secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: '2026-06-09T08:30:00.000Z' },
      planType: 'prolite',
    });
    expect(snapshot.recentToolEvents).toEqual([
      {
        kind: 'tool_call',
        toolName: 'exec_command',
        summary: 'exec_command: rg -n "tail" src',
        at: '2026-06-02T08:00:04.000Z',
      },
    ]);
  });

  it('falls back to task_complete.last_agent_message when final_answer phase is absent', async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, '2026/06/02/rollout-2026-06-02T15-01-00-019e86b4-12ed-7731-9639-c128626a328c.jsonl', [
      JSON.stringify({ timestamp: '2026-06-02T08:01:00.000Z', type: 'session_meta', payload: { id: '019e86b4-12ed-7731-9639-c128626a328c', cwd: '/repo' } }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:05.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-2',
          last_agent_message: '没有结构化 final_answer，但任务已经完成。',
          completed_at: 1780387265,
          duration_ms: 2000,
        },
      }),
    ]);

    const store = new FileCodexObservationStore({ codexHome, now: () => new Date('2026-06-02T08:01:06.000Z') });
    const snapshot = await store.readSnapshot({ codexSessionId: '019e86b4-12ed-7731-9639-c128626a328c' });

    expect(snapshot.availability.kind).toBe('ready');
    expect(snapshot.finalAnswer).toBe('没有结构化 final_answer，但任务已经完成。');
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedAt).toBe('2026-06-02T08:01:05.000Z');
  });

  it('marks a started task as running before commentary appears', async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, '2026/06/02/rollout-2026-06-02T15-01-30-019e86b4-12ed-7731-9639-c128626a328f.jsonl', [
      JSON.stringify({
        timestamp: '2026-06-02T08:01:30.000Z',
        type: 'session_meta',
        payload: { id: '019e86b4-12ed-7731-9639-c128626a328f', cwd: '/repo' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:31.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-3', started_at: 1780387291 },
      }),
    ]);

    const store = new FileCodexObservationStore({ codexHome, now: () => new Date('2026-06-02T08:01:32.000Z') });
    const snapshot = await store.readSnapshot({ codexSessionId: '019e86b4-12ed-7731-9639-c128626a328f' });

    expect(snapshot.availability.kind).toBe('ready');
    expect(snapshot.status).toBe('running');
    expect(snapshot.latestCommentary).toBeUndefined();
    expect(snapshot.finalAnswer).toBeUndefined();
  });

  it('treats a session_meta-only rollout as not yet flushed so PTY fallback can still be used', async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, '2026/06/02/rollout-2026-06-02T15-01-35-019e86b4-12ed-7731-9639-c128626a3280.jsonl', [
      JSON.stringify({
        timestamp: '2026-06-02T08:01:35.000Z',
        type: 'session_meta',
        payload: { id: '019e86b4-12ed-7731-9639-c128626a3280', cwd: '/repo' },
      }),
    ]);

    const store = new FileCodexObservationStore({ codexHome, now: () => new Date('2026-06-02T08:01:36.000Z') });
    const snapshot = await store.readSnapshot({ codexSessionId: '019e86b4-12ed-7731-9639-c128626a3280' });

    expect(snapshot.availability.kind).toBe('not_yet_flushed');
    expect(snapshot.status).toBe('unknown');
    expect(snapshot.latestCommentary).toBeUndefined();
    expect(snapshot.finalAnswer).toBeUndefined();
    expect(snapshot.recentToolEvents).toEqual([]);
  });

  it('falls back to the event timestamp when task_complete.completed_at is absent', async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, '2026/06/02/rollout-2026-06-02T15-01-45-019e86b4-12ed-7731-9639-c128626a3290.jsonl', [
      JSON.stringify({
        timestamp: '2026-06-02T08:01:45.000Z',
        type: 'session_meta',
        payload: { id: '019e86b4-12ed-7731-9639-c128626a3290', cwd: '/repo' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:50.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-4',
          last_agent_message: '缺少 completed_at 时回退到事件时间。',
          duration_ms: 1000,
        },
      }),
    ]);

    const store = new FileCodexObservationStore({ codexHome, now: () => new Date('2026-06-02T08:01:51.000Z') });
    const snapshot = await store.readSnapshot({ codexSessionId: '019e86b4-12ed-7731-9639-c128626a3290' });

    expect(snapshot.availability.kind).toBe('ready');
    expect(snapshot.status).toBe('completed');
    expect(snapshot.completedAt).toBe('2026-06-02T08:01:50.000Z');
  });

  it('resets final-answer state when a new turn starts after a prior turn completed', async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, '2026/06/02/rollout-2026-06-02T15-01-55-019e86b4-12ed-7731-9639-c128626a3291.jsonl', [
      JSON.stringify({
        timestamp: '2026-06-02T08:01:55.000Z',
        type: 'session_meta',
        payload: { id: '019e86b4-12ed-7731-9639-c128626a3291', cwd: '/repo' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:56.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-1', started_at: 1780387316 },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:56.500Z',
        type: 'event_msg',
        payload: { type: 'agent_message', phase: 'commentary', message: '这是上一轮 commentary。' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:56.800Z',
        type: 'response_item',
        payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"git status --short"}' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:57.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: '上一轮已经完成。' }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:58.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-1',
          last_agent_message: '上一轮已经完成。',
          completed_at: 1780387318,
          duration_ms: 2000,
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:01:59.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-2', started_at: 1780387319 },
      }),
    ]);

    const store = new FileCodexObservationStore({ codexHome, now: () => new Date('2026-06-02T08:02:00.000Z') });
    const snapshot = await store.readSnapshot({ codexSessionId: '019e86b4-12ed-7731-9639-c128626a3291' });

    expect(snapshot.availability.kind).toBe('ready');
    expect(snapshot.status).toBe('running');
    expect(snapshot.latestCommentary).toBeUndefined();
    expect(snapshot.finalAnswer).toBeUndefined();
    expect(snapshot.completedAt).toBeUndefined();
    expect(snapshot.recentToolEvents).toEqual([]);
  });

  it('returns not_found when no rollout exists for the requested session id', async () => {
    const codexHome = await createCodexHome();
    const store = new FileCodexObservationStore({ codexHome, now: () => new Date('2026-06-02T08:02:00.000Z') });

    await expect(store.readSnapshot({ codexSessionId: 'missing-session' })).resolves.toMatchObject({
      availability: { kind: 'not_found' },
      status: 'unknown',
      recentToolEvents: [],
    });
  });

  it('returns parse_error when the matching rollout file contains invalid jsonl', async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, '2026/06/02/rollout-2026-06-02T15-02-00-019e86b4-12ed-7731-9639-c128626a328d.jsonl', [
      '{"timestamp":"2026-06-02T08:02:00.000Z","type":"session_meta","payload":{"id":"019e86b4-12ed-7731-9639-c128626a328d","cwd":"/repo"}}',
      '{"timestamp":"2026-06-02T08:02:01.000Z","type":"event_msg","payload":INVALID_JSON',
    ]);

    const store = new FileCodexObservationStore({ codexHome, now: () => new Date('2026-06-02T08:02:02.000Z') });
    const snapshot = await store.readSnapshot({ codexSessionId: '019e86b4-12ed-7731-9639-c128626a328d' });

    expect(snapshot.availability.kind).toBe('parse_error');
    expect(snapshot.status).toBe('unknown');
  });

  it('returns stale when the latest rollout event is older than the freshness window', async () => {
    const codexHome = await createCodexHome();
    await writeRollout(codexHome, '2026/06/02/rollout-2026-06-02T15-03-00-019e86b4-12ed-7731-9639-c128626a328e.jsonl', [
      JSON.stringify({
        timestamp: '2026-06-02T08:03:00.000Z',
        type: 'session_meta',
        payload: { id: '019e86b4-12ed-7731-9639-c128626a328e', cwd: '/repo' },
      }),
      JSON.stringify({
        timestamp: '2026-06-02T08:03:10.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', phase: 'commentary', message: '这是一条过期 commentary。' },
      }),
    ]);

    const store = new FileCodexObservationStore({
      codexHome,
      staleAfterMs: 5_000,
      now: () => new Date('2026-06-02T08:03:20.000Z'),
    });
    const snapshot = await store.readSnapshot({ codexSessionId: '019e86b4-12ed-7731-9639-c128626a328e' });

    expect(snapshot.availability.kind).toBe('stale');
    expect(snapshot.latestCommentary).toBe('这是一条过期 commentary。');
  });
});
