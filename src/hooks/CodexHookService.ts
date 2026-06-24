import { lstat, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import { dirname, resolve } from 'node:path';
import type { ProjectConfig, SessionRecord } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';
import { applyCodexSessionEvent } from '../session/CodexSessionStateMachine.js';
import type { CodexSessionEvent } from '../session/CodexSessionEvents.js';
import type {
  CodexHookEventName,
  CodexHookHandleResult,
  CodexPermissionDecision,
  CodexPermissionRequest,
} from './CodexHookTypes.js';

export interface CodexHookServiceOptions {
  enabled: boolean;
  socketPath: string;
  store: FileStateStore;
  projects: ProjectConfig[];
  now?: () => string;
  permissionTimeoutMs?: number;
  onPermissionRequest?: (request: CodexPermissionRequest) => Promise<void>;
  onPermissionTimeout?: (request: CodexPermissionRequest) => Promise<void>;
}

interface ParsedHookPayload {
  event: CodexHookEventName;
  sessionId?: string;
  cwd?: string;
  hookRequestId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
}

interface PendingPermissionHandle {
  request: CodexPermissionRequest;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: CodexPermissionDecision) => void;
}

const SUPPORTED_EVENTS = new Set<CodexHookEventName>(['session_started', 'user_prompt_submitted', 'stop', 'permission_request']);
const DEFAULT_PERMISSION_TIMEOUT_MS = 300_000;

export class CodexHookService {
  private server?: net.Server;
  private running = false;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly pendingPermissionHandles = new Map<string, PendingPermissionHandle>();

  constructor(private readonly options: CodexHookServiceOptions) {}

  async start(): Promise<void> {
    if (!this.options.enabled || this.running) {
      return;
    }
    await mkdir(dirname(this.options.socketPath), { recursive: true });
    await removeSocketPath(this.options.socketPath);
    this.server = net.createServer({ allowHalfOpen: true }, (socket) => {
      let input = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        input += chunk;
      });
      socket.on('end', () => {
        this.trackInFlight(this.handleRawPayload(input, socket));
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
    this.releasePendingPermissionHandles();
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

  async handlePayload(payload: unknown): Promise<CodexHookHandleResult | CodexPermissionDecision> {
    const parsed = parsePayload(payload);
    if (!parsed) {
      await this.appendHookEvent('hook.ignored', { reason: 'unsupported_payload' });
      return { ok: false, reason: 'unsupported_payload' };
    }

    if (parsed.event === 'permission_request') {
      if (!parsed.hookRequestId || !parsed.sessionId || !parsed.toolName) {
        await this.appendHookEvent('hook.ignored', { reason: 'unsupported_permission_payload' });
        return { ok: false, reason: 'unsupported_permission_payload' };
      }
      const session = await this.findSession(parsed);
      return this.handlePermissionRequest({
        hookRequestId: parsed.hookRequestId,
        sessionId: session?.id ?? parsed.sessionId,
        toolName: parsed.toolName,
        toolInput: parsed.toolInput ?? {},
      });
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

  async handlePermissionRequest(request: CodexPermissionRequest): Promise<CodexPermissionDecision> {
    const decision = this.waitForPermissionDecision(request);
    try {
      const session = await this.options.store.getSession(request.sessionId);
      if (session) {
        const event = {
          type: 'hook.permission_requested' as const,
          sessionId: request.sessionId,
          hookRequestId: request.hookRequestId,
          toolName: request.toolName,
          toolInput: request.toolInput,
          at: this.now(),
        };
        await this.options.store.saveSession(applyCodexSessionEvent(session, event));
        await this.appendHookEvent(event.type, {
          sessionId: request.sessionId,
          hookRequestId: request.hookRequestId,
          toolName: request.toolName,
        });
      } else {
        await this.appendHookEvent('hook.unmatched', {
          hookEvent: 'permission_request',
          hookSessionId: request.sessionId,
          hookRequestId: request.hookRequestId,
        });
      }
      await this.options.onPermissionRequest?.(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.timeoutPermissionRequest(request.hookRequestId);
      await this.appendHookEvent('approval.failed_to_notify', {
        sessionId: request.sessionId,
        hookRequestId: request.hookRequestId,
        toolName: request.toolName,
        reason: message,
      });
    }
    return decision;
  }

  resolvePermissionRequest(hookRequestId: string, decision: Exclude<CodexPermissionDecision, { decision: 'timeout' }>): boolean {
    const handle = this.pendingPermissionHandles.get(hookRequestId);
    if (!handle) {
      return false;
    }
    clearTimeout(handle.timer);
    this.pendingPermissionHandles.delete(hookRequestId);
    handle.resolve(decision);
    return true;
  }

  private async handleRawPayload(raw: string, socket: net.Socket): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendHookEvent('hook.parse_failed', { reason: message });
      socket.end();
      return;
    }
    try {
      const result = await this.handlePayload(parsed);
      if ('decision' in result && result.decision !== 'timeout') {
        socket.end(JSON.stringify(toCodexPermissionDecisionOutput(result)));
        return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.appendHookEvent('hook.handle_failed', { reason: message });
    }
    socket.end();
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

  private waitForPermissionDecision(request: CodexPermissionRequest): Promise<CodexPermissionDecision> {
    const hookRequestId = request.hookRequestId;
    const previous = this.pendingPermissionHandles.get(hookRequestId);
    if (previous) {
      clearTimeout(previous.timer);
      previous.resolve({ decision: 'timeout' });
      this.pendingPermissionHandles.delete(hookRequestId);
    }

    const timeoutMs = this.options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    return new Promise<CodexPermissionDecision>((resolveDecision) => {
      const timer = setTimeout(() => {
        this.timeoutPermissionRequest(hookRequestId);
      }, timeoutMs);
      this.pendingPermissionHandles.set(hookRequestId, { request, timer, resolve: resolveDecision });
    });
  }

  private releasePendingPermissionHandles(): void {
    for (const hookRequestId of [...this.pendingPermissionHandles.keys()]) {
      this.timeoutPermissionRequest(hookRequestId);
    }
  }

  private timeoutPermissionRequest(hookRequestId: string): void {
    const handle = this.pendingPermissionHandles.get(hookRequestId);
    if (!handle) {
      return;
    }
    clearTimeout(handle.timer);
    this.pendingPermissionHandles.delete(hookRequestId);
    handle.resolve({ decision: 'timeout' });
    void this.options.onPermissionTimeout?.(handle.request).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      void this.appendHookEvent('hook.permission_timeout_failed', {
        sessionId: handle.request.sessionId,
        hookRequestId,
        reason: message,
      }).catch(() => undefined);
    });
  }
}

function parsePayload(payload: unknown): ParsedHookPayload | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  const event = parseHookEventName(readFirstString(record.event, record.hook_event_name));
  if (!event) {
    return undefined;
  }
  return {
    event,
    sessionId: typeof record.session_id === 'string' ? record.session_id : undefined,
    cwd: typeof record.cwd === 'string' ? record.cwd : undefined,
    hookRequestId: readFirstString(record.request_id, record.hook_request_id, record.tool_use_id, record.turn_id, record.id),
    toolName: readFirstString(record.tool_name, record.toolName),
    toolInput: isRecord(record.tool_input) ? record.tool_input : isRecord(record.toolInput) ? record.toolInput : undefined,
  };
}

function parseHookEventName(event: string | undefined): CodexHookEventName | undefined {
  switch (event) {
    case 'session_started':
    case 'user_prompt_submitted':
    case 'stop':
    case 'permission_request':
      return SUPPORTED_EVENTS.has(event) ? event : undefined;
    case 'SessionStart':
      return 'session_started';
    case 'UserPromptSubmit':
      return 'user_prompt_submitted';
    case 'Stop':
      return 'stop';
    case 'PermissionRequest':
      return 'permission_request';
    default:
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readFirstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function toCodexPermissionDecisionOutput(decision: Exclude<CodexPermissionDecision, { decision: 'timeout' }>): Record<string, unknown> {
  if (decision.decision === 'allow') {
    return {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'allow' },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: {
        behavior: 'deny',
        message: decision.reason,
      },
    },
  };
}

function toSessionEvent(payload: ParsedHookPayload, sessionId: string, at: string): CodexSessionEvent {
  switch (payload.event) {
    case 'session_started':
      return { type: 'hook.session_started' as const, sessionId, hookSessionId: payload.sessionId, cwd: payload.cwd, at };
    case 'user_prompt_submitted':
      return { type: 'hook.user_prompt_submitted' as const, sessionId, hookSessionId: payload.sessionId, cwd: payload.cwd, at };
    case 'stop':
      return { type: 'hook.stop' as const, sessionId, hookSessionId: payload.sessionId, at };
    case 'permission_request':
      throw new Error('permission_request events are handled before session event conversion');
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
