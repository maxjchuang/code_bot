import type { BotConfig } from '../../src/domain/types.js';
import type { CodexRunOptions, CodexRunner } from '../../src/codex/CodexRunner.js';
import type { CodexObservationSnapshot, CodexObservationStore } from '../../src/observations/CodexObservationStore.js';

export function sampleConfig(projectPath: string): BotConfig {
  return {
    feishu: { appId: 'cli', appSecret: 'secret' },
    restrictUsers: true,
    restrictChatIds: true,
    allowedUsers: ['ou_1'],
    allowedChatIds: ['oc_1'],
    projects: [
      { id: 'repo', name: 'Repo', path: projectPath, codexArgs: [] },
      { id: 'repo2', name: 'Repo 2', path: projectPath, codexArgs: [] },
    ],
    output: { directMaxChars: 1800, chunkSize: 1500 },
    codex: { command: 'codex', defaultArgs: [] },
    logLevel: 'info',
    ui: { verbosity: 'normal' },
    notifications: { enabled: true, idleMs: 10, maxFinalChars: 8000, failureTailChars: 2000 },
  };
}

export class FakeCodexRunner implements CodexRunner {
  readonly sentMessages: string[] = [];
  readonly starts: CodexRunOptions[] = [];
  startError?: Error;
  private readonly sessions = new Set<string>();
  private readonly sessionOptions = new Map<string, CodexRunOptions>();

  async healthCheck(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async start(options: CodexRunOptions): Promise<void> {
    if (!this.starts.includes(options)) {
      this.starts.push(options);
    }
    if (this.startError) {
      throw this.startError;
    }
    this.sessions.add(options.sessionId);
    this.sessionOptions.set(options.sessionId, options);
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Unknown fake session: ${sessionId}`);
    }
    this.sentMessages.push(text);
  }

  async stop(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.sessionOptions.delete(sessionId);
  }

  async emitOutput(sessionId: string, text: string): Promise<void> {
    const options = this.sessionOptions.get(sessionId);
    if (!options) {
      throw new Error(`Unknown fake session: ${sessionId}`);
    }
    await Promise.resolve(options.onOutput(text));
  }

  async exit(sessionId: string, exitCode: number | undefined): Promise<void> {
    const options = this.sessionOptions.get(sessionId);
    if (!options) {
      throw new Error(`Unknown fake session: ${sessionId}`);
    }
    this.sessions.delete(sessionId);
    this.sessionOptions.delete(sessionId);
    await Promise.resolve(options.onExit(exitCode));
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

export class FakeCodexObservationStore implements CodexObservationStore {
  readonly snapshots = new Map<string, CodexObservationSnapshot>();
  readSnapshotError?: Error;

  async readSnapshot(input: { codexSessionId: string }): Promise<CodexObservationSnapshot> {
    if (this.readSnapshotError) {
      throw this.readSnapshotError;
    }
    return (
      this.snapshots.get(input.codexSessionId) ?? {
        availability: { kind: 'not_found' },
        codexSessionId: input.codexSessionId,
        status: 'unknown',
        latestActivityAt: undefined,
        recentToolEvents: [],
      }
    );
  }
}
