import type { BotConfig } from '../../src/domain/types.js';
import type { CodexRunOptions, CodexRunner } from '../../src/codex/CodexRunner.js';

export function sampleConfig(projectPath: string): BotConfig {
  return {
    feishu: { appId: 'cli', appSecret: 'secret' },
    allowedUsers: ['ou_1'],
    allowedChatIds: ['oc_1'],
    projects: [{ id: 'repo', name: 'Repo', path: projectPath, codexArgs: [] }],
    output: { directMaxChars: 1800, chunkSize: 1500 },
    codex: { command: 'codex', defaultArgs: [] },
  };
}

export class FakeCodexRunner implements CodexRunner {
  readonly sentMessages: string[] = [];
  private sessions = new Set<string>();

  async healthCheck(): Promise<{ ok: true }> {
    return { ok: true };
  }

  async start(options: CodexRunOptions): Promise<void> {
    this.sessions.add(options.sessionId);
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (!this.sessions.has(sessionId)) {
      throw new Error(`Unknown fake session: ${sessionId}`);
    }
    this.sentMessages.push(text);
  }

  async stop(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }
}
