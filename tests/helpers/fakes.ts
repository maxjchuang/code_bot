import type { BotConfig } from '../../src/domain/types.js';
import type { CodexRunOptions, CodexRunner } from '../../src/codex/CodexRunner.js';
import type { CodexObservationSnapshot, CodexObservationStore } from '../../src/observations/CodexObservationStore.js';
import type { CodexModelCatalog } from '../../src/models/CodexModelCatalog.js';

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
    output: {
      directMaxChars: 1800,
      chunkSize: 1500,
      terminalSnapshot: {
        cols: 120,
        rows: 40,
        scrollback: 200,
        replayMaxBytes: 262144,
        cardMaxRows: 40,
        cardMaxLineChars: 160,
        maxStyledSegmentsPerLine: 8,
      },
    },
    codex: { command: 'codex', defaultArgs: [] },
    logLevel: 'info',
    ui: { verbosity: 'normal' },
    notifications: { enabled: true, idleMs: 10, maxFinalChars: 8000, failureTailChars: 2000 },
    upgrade: {
      enabled: false,
      adminUsers: [],
      pm2ProcessName: 'code-bot',
      remote: 'origin',
      branch: 'main',
    },
  };
}

export const sampleModelCatalog: CodexModelCatalog = {
  kind: 'available',
  fetchedAt: '2026-06-03T13:43:32.128077Z',
  clientVersion: '0.136.0',
  models: [
    {
      slug: 'gpt-5.5',
      displayName: 'GPT 5.5',
      description: 'Most capable model',
      priority: 10,
      defaultReasoningLevel: 'medium',
      supportedReasoningLevels: ['low', 'medium', 'high'],
    },
    {
      slug: 'gpt-5.5-mini',
      displayName: 'GPT 5.5 Mini',
      description: 'Fast model',
      priority: 20,
      defaultReasoningLevel: 'low',
      supportedReasoningLevels: ['low', 'medium'],
    },
  ],
};

export class FakeCodexRunner implements CodexRunner {
  readonly sentMessages: string[] = [];
  readonly starts: CodexRunOptions[] = [];
  startError?: Error;
  version?: string;
  private readonly sessions = new Set<string>();
  private readonly sessionOptions = new Map<string, CodexRunOptions>();
  private readonly queuedStatusResponses = new Map<string, string[]>();

  async healthCheck(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async getVersion(): Promise<string | undefined> {
    return this.version;
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
    if (text === 'status') {
      const nextResponse = this.queuedStatusResponses.get(sessionId)?.shift();
      if (nextResponse !== undefined) {
        queueMicrotask(() => {
          void this.emitOutput(sessionId, nextResponse);
        });
      }
    }
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

  queueStatusResponse(sessionId: string, text: string): void {
    const queue = this.queuedStatusResponses.get(sessionId) ?? [];
    queue.push(text);
    this.queuedStatusResponses.set(sessionId, queue);
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
