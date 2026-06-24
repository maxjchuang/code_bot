import { lstat, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import type { ProjectConfig, SessionRecord } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';
import { applyCodexSessionEvent } from '../session/CodexSessionStateMachine.js';
import type { CodexHookEventName, CodexHookHandleResult } from './CodexHookTypes.js';

export interface CodexHookServiceOptions {
  enabled: boolean;
  socketPath: string;
  store: FileStateStore;
  projects: ProjectConfig[];
  now?: () => string;
}

interface ParsedHookPayload {
  event: CodexHookEventName;
  sessionId?: string;
  cwd?: string;
}

const SUPPORTED_EVENTS = new Set<CodexHookEventName>(['session_started', 'user_prompt_submitted', 'stop']);

export class CodexHookService {
  private server?: net.Server;
  private running = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(private readonly options: CodexHookServiceOptions) {}

  async start(): Promise<void> {
    if (!this.options.enabled || this.running) {
      return;
    }
    await mkdir(dirname(this.options.socketPath), { recursive: true });
    await removeSocketPath(this.options.socketPath);
    this.server = net.createServer((socket) => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        input += chunk;
      });
      socket.on('end', () => {
        this.trackInFlight(this.handleRawPayload(input));
      });
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      this.server!.once('error', rejectListen);
      this.server!.listen(this.options.socketPath, () => {
        this.server!.off('error', rejectListen);
        this.running = true;
        resolveListen();
      });
    });
    this.server.unref();
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }
    const server = this.server;
    this.server = undefined;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    });
    await this.waitForInFlight();
    this.running = false;
    await removeSocketPath(this.options.socketPath);
  }

  isRunning(): boolean {
    return this.running;
  }

  async handlePayload(payload: unknown): Promise<CodexHookHandleResult> {
    const parsed = parsePayload(payload);
    if (!parsed) {
      await this.appendHookEvent('hook.ignored', { reason: 'unsupported_payload' });
      return { ok: false, reason: 'unsupported_payload' };
    }

    const session = await this.findSession(parsed);
    if (!session) {
      await this.appendHookEvent('hook.unmatched', {
        hookEvent: parsed.event,
        hookSessionId: parsed.sessionId,
        cwd: parsed.cwd,
      });
      return { ok: true };
    }

    const event = toSessionEvent(parsed, session.id, this.now());
    const updated = applyCodexSessionEvent(session, event);
    await this.options.store.saveSession(updated);
    await this.appendHookEvent(event.type, {
      sessionId: session.id,
      hookSessionId: parsed.sessionId,
      cwd: parsed.cwd,
    });
    return { ok: true };
  }

  private async handleRawPayload(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendHookEvent('hook.parse_failed', { reason: message });
      return;
    }
    await this.handlePayload(parsed);
  }

  private async findSession(payload: ParsedHookPayload): Promise<SessionRecord | undefined> {
    if (payload.sessionId) {
      const direct = await this.options.store.getSession(payload.sessionId);
      if (direct) {
        return direct;
      }
      const sessions = await this.options.store.listSessions();
      const matchedHookSession = sessions.find((session) => session.codexHookSessionId === payload.sessionId);
      if (matchedHookSession) {
        return matchedHookSession;
      }
    }
    if (!payload.cwd) {
      return undefined;
    }
    const project = this.options.projects.find((candidate) => resolve(candidate.path) === resolve(payload.cwd!));
    if (!project) {
      return undefined;
    }
    const sessions = await this.options.store.listSessions();
    return sessions.find((session) => session.projectId === project.id && isActiveSession(session));
  }

  private trackInFlight(action: Promise<void>): void {
    const tracked = action.catch(() => undefined);
    this.inFlight.add(tracked);
    void tracked.finally(() => {
      this.inFlight.delete(tracked);
    });
  }

  private async waitForInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
  }

  private async appendHookEvent(type: string, data: Record<string, unknown>): Promise<void> {
    await this.options.store.appendEvent({ type, at: this.now(), data });
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }
}

function parsePayload(payload: unknown): ParsedHookPayload | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (!isSupportedEvent(record.event)) {
    return undefined;
  }
  return {
    event: record.event,
    sessionId: typeof record.session_id === 'string' ? record.session_id : undefined,
    cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
  };
}

function isSupportedEvent(event: unknown): event is CodexHookEventName {
  return typeof event === 'string' && SUPPORTED_EVENTS.has(event as CodexHookEventName);
}

function toSessionEvent(payload: ParsedHookPayload, sessionId: string, at: string) {
  switch (payload.event) {
    case 'session_started':
      return { type: 'hook.session_started' as const, sessionId, hookSessionId: payload.sessionId, cwd: payload.cwd, at };
    case 'user_prompt_submitted':
      return { type: 'hook.user_prompt_submitted' as const, sessionId, hookSessionId: payload.sessionId, cwd: payload.cwd, at };
    case 'stop':
      return { type: 'hook.stop' as const, sessionId, hookSessionId: payload.sessionId, at };
  }
}

function isActiveSession(session: SessionRecord): boolean {
  return session.status === 'starting' || session.status === 'running';
}

async function removeSocketPath(socketPath: string): Promise<void> {
  try {
    const stats = await lstat(socketPath);
    if (!stats.isSocket()) {
      throw new Error(`Refusing to remove non-socket hook path: ${socketPath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return;
    }
    throw error;
  }
  await rm(socketPath, { force: true });
}
