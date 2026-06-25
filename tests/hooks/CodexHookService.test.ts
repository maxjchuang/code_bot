import net from 'node:net';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

function serviceFor(root: string, store: FileStateStore, overrides: Partial<ConstructorParameters<typeof CodexHookService>[0]> = {}): CodexHookService {
  return new CodexHookService({
    enabled: true,
    socketPath: join(root, '.code-bot/codex-hooks.sock'),
    store,
    projects: sampleConfig(root).projects,
    now: () => '2026-06-24T00:00:01.000Z',
    permissionTimeoutMs: 50,
    ...overrides,
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

async function sendSocketPayloadWithResponse(socketPath: string, payload: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let output = '';
    client.setEncoding('utf8');
    client.on('data', (chunk) => {
      output += chunk;
    });
    client.on('error', reject);
    client.on('connect', () => client.end(payload));
    client.on('close', () => resolve(output));
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
    const service = serviceFor(root, store, { permissionTimeoutMs: 1_000 });
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

  it('permission request waits until allow response is resolved', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    const service = serviceFor(root, store);

    const waiting = service.handlePermissionRequest({
      hookRequestId: 'hook_req_allow',
      sessionId,
      toolName: 'shell',
      toolInput: { command: 'npm test' },
    });
    await waitForPendingPromise();

    expect(service.resolvePermissionRequest('hook_req_allow', { decision: 'allow' })).toBe(true);
    await expect(waiting).resolves.toEqual({ decision: 'allow' });
  });

  it('permission request waits until deny response is resolved', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    const service = serviceFor(root, store);

    const waiting = service.handlePermissionRequest({
      hookRequestId: 'hook_req_deny',
      sessionId,
      toolName: 'shell',
      toolInput: { command: 'rm -rf build' },
    });
    await waitForPendingPromise();

    expect(service.resolvePermissionRequest('hook_req_deny', { decision: 'deny', reason: 'Rejected by ou_1' })).toBe(true);
    await expect(waiting).resolves.toEqual({ decision: 'deny', reason: 'Rejected by ou_1' });
  });

  it('permission request times out with no allow or deny response', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
      const sessionId = await writeSession(store, root);
      const service = new CodexHookService({
        enabled: true,
        socketPath: join(root, '.code-bot/codex-hooks.sock'),
        store,
        projects: sampleConfig(root).projects,
        now: () => '2026-06-24T00:00:01.000Z',
        permissionTimeoutMs: 100,
      });

      const waiting = service.handlePermissionRequest({
        hookRequestId: 'hook_req_timeout',
        sessionId,
        toolName: 'shell',
        toolInput: { command: 'npm install' },
      });
      await vi.advanceTimersByTimeAsync(100);

      await expect(waiting).resolves.toEqual({ decision: 'timeout' });
      expect(service.resolvePermissionRequest('hook_req_timeout', { decision: 'allow' })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('permission request timeout notifies callback and expires pending handle', async () => {
    vi.useFakeTimers();
    try {
      const root = await createTmpDir();
      const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
      const sessionId = await writeSession(store, root);
      const onPermissionTimeout = vi.fn().mockResolvedValue(undefined);
      const service = serviceFor(root, store, { permissionTimeoutMs: 100, onPermissionTimeout });

      const request = {
        hookRequestId: 'hook_req_timeout_callback',
        sessionId,
        toolName: 'shell',
        toolInput: { command: 'npm install' },
      };
      const waiting = service.handlePermissionRequest(request);
      await vi.advanceTimersByTimeAsync(100);

      await expect(waiting).resolves.toEqual({ decision: 'timeout' });
      expect(onPermissionTimeout).toHaveBeenCalledWith(request);
      expect(service.resolvePermissionRequest('hook_req_timeout_callback', { decision: 'allow' })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stop releases pending permission requests without waiting for permission timeout', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    const onPermissionTimeout = vi.fn().mockResolvedValue(undefined);
    const service = serviceFor(root, store, { permissionTimeoutMs: 10_000, onPermissionTimeout });
    await service.start();

    const waiting = service.handlePermissionRequest({
      hookRequestId: 'hook_req_stop',
      sessionId,
      toolName: 'shell',
      toolInput: { command: 'npm install' },
    });
    await waitForPendingPromise();
    await service.stop();

    await expect(waiting).resolves.toEqual({ decision: 'timeout' });
    expect(onPermissionTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ hookRequestId: 'hook_req_stop', sessionId }),
    );
  });

  it('permission hook emits hook.permission_requested and moves session to waiting_for_approval', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    const service = serviceFor(root, store);

    const waiting = service.handlePermissionRequest({
      hookRequestId: 'hook_req_state',
      sessionId,
      toolName: 'shell',
      toolInput: { command: 'npm install' },
    });
    await waitForPendingPromise();

    await waitForSessionPhase(store, sessionId, 'waiting_for_approval');
    const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
    expect(events).toContain('"type":"hook.permission_requested"');

    service.resolvePermissionRequest('hook_req_state', { decision: 'deny' });
    await waiting;
  });

  it('permission hook matches stored codexHookSessionId before notifying approval flow', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    await store.updateSession(sessionId, (session) => ({ ...session, codexHookSessionId: 'hook-session-1' }));
    const onPermissionRequest = vi.fn().mockResolvedValue(undefined);
    const service = serviceFor(root, store, { onPermissionRequest });

    const waiting = service.handlePayload({
      event: 'permission_request',
      session_id: 'hook-session-1',
      request_id: 'hook_req_hook_session',
      tool_name: 'shell',
      tool_input: { command: 'npm test' },
    });
    await waitForAssertion(() => {
      expect(onPermissionRequest).toHaveBeenCalledWith(
        expect.objectContaining({ hookRequestId: 'hook_req_hook_session', sessionId }),
      );
    });

    service.resolvePermissionRequest('hook_req_hook_session', { decision: 'allow' });
    await expect(waiting).resolves.toEqual({ decision: 'allow' });
  });

  it('permission hook accepts Codex wire payload and returns Codex allow output over the socket', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    await store.updateSession(sessionId, (session) => ({ ...session, codexHookSessionId: 'hook-session-1' }));
    const service = serviceFor(root, store);
    await service.start();

    const responsePromise = sendSocketPayloadWithResponse(
      join(root, '.code-bot/codex-hooks.sock'),
      JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: 'hook-session-1',
        turn_id: 'turn_1',
        tool_name: 'shell',
        tool_input: { command: 'npm test' },
      }),
    );
    await waitForSessionPhase(store, sessionId, 'waiting_for_approval');
    expect(service.resolvePermissionRequest('turn_1', { decision: 'allow' })).toBe(true);

    await expect(responsePromise).resolves.toBe(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }),
    );
    await service.stop();
  });

  it('permission hook closes socket and records failed_to_notify when approval notification fails', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    const service = serviceFor(root, store, {
      permissionTimeoutMs: 1_000,
      onPermissionRequest: vi.fn().mockRejectedValue(new Error('feishu unavailable')),
      onPermissionTimeout: vi.fn().mockResolvedValue(undefined),
    });
    await service.start();

    const response = await sendSocketPayloadWithResponse(
      join(root, '.code-bot/codex-hooks.sock'),
      JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: sessionId,
        turn_id: 'turn_failed_notify',
        tool_name: 'shell',
        tool_input: { command: 'npm test' },
      }),
    );

    expect(response).toBe('');
    expect(service.resolvePermissionRequest('turn_failed_notify', { decision: 'allow' })).toBe(false);
    await waitForAssertion(async () => {
      const events = await readFile(join(root, '.code-bot/events/2026-06-24.jsonl'), 'utf8');
      expect(events).toContain('"type":"approval.failed_to_notify"');
    });
    await service.stop();
  });

  it('permission hook releases pending request when session update fails before notification', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-24T00:00:01.000Z'));
    const sessionId = await writeSession(store, root);
    const onPermissionRequest = vi.fn().mockResolvedValue(undefined);
    const service = serviceFor(root, store, { permissionTimeoutMs: 10_000, onPermissionRequest });
    vi.spyOn(store, 'saveSession').mockRejectedValueOnce(new Error('state unavailable'));

    const waiting = service.handlePermissionRequest({
      hookRequestId: 'hook_req_prepare_failed',
      sessionId,
      toolName: 'shell',
      toolInput: { command: 'npm test' },
    });
    let resolvedDecision: unknown;
    void waiting.then((decision) => {
      resolvedDecision = decision;
    });
    await waitForAssertion(() => {
      expect(resolvedDecision).toEqual({ decision: 'timeout' });
    });

    expect(service.resolvePermissionRequest('hook_req_prepare_failed', { decision: 'allow' })).toBe(false);
    expect(onPermissionRequest).not.toHaveBeenCalled();
  });
});

async function waitForPendingPromise(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForSessionPhase(store: FileStateStore, sessionId: string, phase: string): Promise<void> {
  const startedAt = Date.now();
  let lastSessionPhase: string | undefined;
  while (Date.now() - startedAt < 500) {
    lastSessionPhase = (await store.getSession(sessionId))?.phase;
    if (lastSessionPhase === phase) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(lastSessionPhase).toBe(phase);
}

async function waitForAssertion(assertion: () => void | Promise<void>): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < 500) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) {
    throw lastError;
  }
}
