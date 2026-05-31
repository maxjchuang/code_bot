import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import pty from 'node-pty';

export interface CodexRunOptions {
  sessionId: string;
  cwd: string;
  args: string[];
  onOutput: (text: string) => void;
  onExit: (exitCode: number | undefined) => void;
}

export interface CodexRunner {
  healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }>;
  start(options: CodexRunOptions): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
}

export function createCodexSessionId(seed: string = Math.random().toString(36).slice(2)): string {
  return `sess_${seed}_${Date.now().toString(36)}`;
}

export class PtyCodexRunner implements CodexRunner {
  private readonly processes = new Map<string, pty.IPty>();

  constructor(private readonly config: { command: string; defaultArgs: string[] }) {}

  async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const found = await findExecutable(this.config.command);
    return found ? { ok: true } : { ok: false, reason: `Command not found: ${this.config.command}` };
  }

  async start(options: CodexRunOptions): Promise<void> {
    const term = pty.spawn(this.config.command, [...this.config.defaultArgs, ...options.args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: options.cwd,
      env: process.env,
    });
    this.processes.set(options.sessionId, term);
    term.onData(options.onOutput);
    term.onExit((event) => {
      this.processes.delete(options.sessionId);
      options.onExit(event.exitCode);
    });
  }

  async send(sessionId: string, text: string): Promise<void> {
    const term = this.requireProcess(sessionId);
    term.write(`${text}\r`);
  }

  async stop(sessionId: string): Promise<void> {
    const term = this.requireProcess(sessionId);
    term.kill();
    this.processes.delete(sessionId);
  }

  private requireProcess(sessionId: string): pty.IPty {
    const term = this.processes.get(sessionId);
    if (!term) {
      throw new Error(`Codex session is not running: ${sessionId}`);
    }
    return term;
  }
}

async function findExecutable(command: string): Promise<boolean> {
  if (isAbsolute(command)) {
    return canExecute(command);
  }
  const paths = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of paths) {
    if (await canExecute(`${dir}/${command}`)) {
      return true;
    }
  }
  return false;
}

async function canExecute(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
