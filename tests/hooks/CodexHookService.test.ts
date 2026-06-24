import net from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { CodexHookService } from '../../src/hooks/CodexHookService.js';
import { createTmpDir } from '../helpers/tmp.js';
import { sampleConfig } from '../helpers/fakes.js';

async function writeSession(store: FileStateStore, root: string): Promise<string> {
  const sessionId = 'sess_hook';
  await store.saveSession({
    id: sessionId,
    chatId: 'oc_1',
    projectId: 'repo',
    status: 'running',
    phase: 'waiting_for_input',
    createdBy: 'ou_1',
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
    logPath: join(root, '.code-bot/logs/sessions/sess_hook.log'),
  });
  return sessionId;
}

function serviceFor(root: string, store: FileStateStore): CodexHookService {
  return new CodexHookService({
    enabled: true,
    socketPath: join(root, '.code-bot/codex-hooks.sock'),
    store,
    projects: sampleConfig(root).projects,
    now: () => '2026-06-24T00:00:01.000Z',
  });
}

async function sendSocketPayload(socketPath: string, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    client.on('error', reject);
    client.on('connect', () => client.end(payload));
    client.on('close', () => resolve());
  });
}

describe('CodexHookService', () => {
  it('accepts session_started hook payload and appends hook.session_started event', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);

    await expect(serviceFor(root, store).handlePayload({
      event: 'session_started',
      session_id: sessionId,
      cwd: root,
    })).resolves.toEqual({ ok: true });

    await expect(store.getSession(sessionId)).resolves.toMatchObject({ codexHookSessionId: sessionId });
    const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
    expect(events).toContain('"type":"hook.session_started"');
  });

  it('accepts user_prompt_submitted hook payload and appends hook.user_prompt_submitted event', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);

    await serviceFor(root, store).handlePayload({
      event: 'user_prompt_submitted',
      session_id: sessionId,
      cwd: root,
    });

    await expect(store.getSession(sessionId)).resolves.toMatchObject({ phase: 'processing' });
    const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
    expect(events).toContain('"type":"hook.user_prompt_submitted"');
  });

  it('accepts stop hook payload and appends hook.stop event', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);

    await serviceFor(root, store).handlePayload({ event: 'stop', session_id: sessionId });

    await expect(store.getSession(sessionId)).resolves.toMatchObject({
      status: 'running',
      phase: 'waiting_for_input',
    });
    const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
    expect(events).toContain('"type":"hook.stop"');
  });

  it('records hook.parse_failed for malformed JSON', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const service = serviceFor(root, store);
    await service.start();
    try {
      await sendSocketPayload(join(root, '.code-bot/codex-hooks.sock'), '{not-json');
    } finally {
      await service.stop();
    }

    const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
    expect(events).toContain('"type":"hook.parse_failed"');
  });

  it('does not delete a non-socket file at the configured socket path', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const socketPath = join(root, '.code-bot/codex-hooks.sock');
    await mkdir(join(root, '.code-bot'), { recursive: true });
    await writeFile(socketPath, 'not a socket', 'utf8');
    const service = new CodexHookService({
      enabled: true,
      socketPath,
      store,
      projects: sampleConfig(root).projects,
    });

    await expect(service.start()).rejects.toThrow('Refusing to remove non-socket hook path');
    await expect(readFile(socketPath, 'utf8')).resolves.toBe('not a socket');
    await expect(service.stop()).resolves.toBeUndefined();
    await expect(readFile(socketPath, 'utf8')).resolves.toBe('not a socket');
  });

  it('waits for in-flight socket payload handling before stop resolves', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    const service = serviceFor(root, store);
    await service.start();

    await sendSocketPayload(join(root, '.code-bot/codex-hooks.sock'), JSON.stringify({ event: 'user_prompt_submitted', session_id: sessionId }));
    await service.stop();

    await expect(store.getSession(sessionId)).resolves.toMatchObject({ phase: 'processing' });
  });

  it('matches later hook events by stored codexHookSessionId', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    const service = serviceFor(root, store);
    await service.handlePayload({ event: 'session_started', session_id: 'hook-session-1', cwd: root });

    await service.handlePayload({ event: 'user_prompt_submitted', session_id: 'hook-session-1' });

    await expect(store.getSession(sessionId)).resolves.toMatchObject({
      codexHookSessionId: 'hook-session-1',
      phase: 'processing',
    });
  });

  it('does not throw when listener is unavailable and hooks are disabled', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const service = new CodexHookService({
      enabled: false,
      socketPath: join(root, '.code-bot/codex-hooks.sock'),
      store,
      projects: sampleConfig(root).projects,
    });

    await expect(service.start()).resolves.toBeUndefined();
    expect(service.isRunning()).toBe(false);
  });
});
