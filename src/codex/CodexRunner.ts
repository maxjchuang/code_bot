import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import pty from 'node-pty';

const SUBMIT_ENTER_DELAY_MS = 10;
export const CODEX_TUI_SUBMIT_SEQUENCE = '\x18';
const CODEX_TUI_KEYMAP_ARGS = [
  '-c',
  'tui.keymap.composer.submit="ctrl-x"',
  '-c',
  'tui.keymap.editor.insert_newline=["ctrl-j","shift-enter","alt-enter"]',
];

export type CodexStartMode =
  | { kind: 'new' }
  | { kind: 'resume'; target: string };

export interface CodexRunOptions {
  sessionId: string;
  cwd: string;
  args: string[];
  mode?: CodexStartMode;
  onOutput: (text: string) => void;
  onExit: (exitCode: number | undefined) => void;
}

export interface CodexRunner {
  healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }>;
  getVersion?(): Promise<string | undefined>;
  start(options: CodexRunOptions): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
}

export function createCodexSessionId(seed: string = Math.random().toString(36).slice(2)): string {
  return `sess_${seed}_${Date.now().toString(36)}`;
}

export class PtyCodexRunner implements CodexRunner {
  private readonly processes = new Map<string, pty.IPty>();
  private versionPromise?: Promise<string | undefined>;

  constructor(
    private readonly config: { command: string; defaultArgs: string[] },
    private readonly ptyModule: Pick<typeof pty, 'spawn'> = pty,
  ) {}

  async healthCheck(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const found = await findExecutable(this.config.command);
    return found ? { ok: true } : { ok: false, reason: `Command not found: ${this.config.command}` };
  }

  async getVersion(): Promise<string | undefined> {
    if (!this.versionPromise) {
      this.versionPromise = readCodexVersion(this.config.command);
    }
    return this.versionPromise;
  }

  async start(options: CodexRunOptions): Promise<void> {
    if (this.processes.has(options.sessionId)) {
      throw new Error(`Codex session is already running: ${options.sessionId}`);
    }
    const mode = options.mode ?? { kind: 'new' };
    const defaultArgs = removeOverriddenDefaultModelArgs(this.config.defaultArgs, options.args);
    const args =
      mode.kind === 'resume'
        ? ['resume', ...defaultArgs, ...options.args, ...CODEX_TUI_KEYMAP_ARGS, mode.target]
        : [...defaultArgs, ...options.args, ...CODEX_TUI_KEYMAP_ARGS];
    const term = this.ptyModule.spawn(this.config.command, args, {
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
    term.write(text);
    await delay(SUBMIT_ENTER_DELAY_MS);
    term.write(CODEX_TUI_SUBMIT_SEQUENCE);
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

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function findExecutable(command: string): Promise<boolean> {
  if (isAbsolute(command)) {
    return canExecute(command);
  }
  if (command.includes('/') || command.includes('\\')) {
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

async function readCodexVersion(command: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    execFile(command, ['--version'], { timeout: 2_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const version = stdout.trim();
      resolve(version.length > 0 ? version : undefined);
    });
  });
}

interface ModelArgOverrides {
  model: boolean;
  reasoningEffort: boolean;
}

function removeOverriddenDefaultModelArgs(defaultArgs: string[], sessionArgs: string[]): string[] {
  const overrides = findModelArgOverrides(sessionArgs);
  if (!overrides.model && !overrides.reasoningEffort) {
    return [...defaultArgs];
  }

  const args: string[] = [];
  for (let index = 0; index < defaultArgs.length; index += 1) {
    const arg = defaultArgs[index]!;
    if ((arg === '--model' || arg === '-m') && overrides.model) {
      index += 1;
      continue;
    }
    if ((arg.startsWith('--model=') || arg.startsWith('-m=')) && overrides.model) {
      continue;
    }
    if ((arg === '-c' || arg === '--config') && shouldStripConfigArg(defaultArgs[index + 1], overrides)) {
      index += 1;
      continue;
    }
    if (shouldStripConfigArg(inlineConfigValue(arg), overrides)) {
      continue;
    }
    args.push(arg);
  }
  return args;
}

function findModelArgOverrides(args: string[]): ModelArgOverrides {
  const overrides: ModelArgOverrides = { model: false, reasoningEffort: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--model' || arg === '-m') {
      overrides.model = true;
      index += 1;
      continue;
    }
    if (arg.startsWith('--model=') || arg.startsWith('-m=')) {
      overrides.model = true;
      continue;
    }
    if (arg === '-c' || arg === '--config') {
      markConfigArgOverride(args[index + 1], overrides);
      index += 1;
      continue;
    }
    markConfigArgOverride(inlineConfigValue(arg), overrides);
  }
  return overrides;
}

function markConfigArgOverride(configArg: string | undefined, overrides: ModelArgOverrides): void {
  if (isModelConfigArg(configArg)) {
    overrides.model = true;
  }
  if (isReasoningEffortConfigArg(configArg)) {
    overrides.reasoningEffort = true;
  }
}

function shouldStripConfigArg(configArg: string | undefined, overrides: ModelArgOverrides): boolean {
  return (overrides.model && isModelConfigArg(configArg)) || (overrides.reasoningEffort && isReasoningEffortConfigArg(configArg));
}

function isModelConfigArg(arg: string | undefined): boolean {
  return arg?.startsWith('model=') ?? false;
}

function isReasoningEffortConfigArg(arg: string | undefined): boolean {
  return arg?.startsWith('model_reasoning_effort=') ?? false;
}

function inlineConfigValue(arg: string): string | undefined {
  if (arg.startsWith('--config=')) {
    return arg.slice('--config='.length);
  }
  if (arg.startsWith('-c=')) {
    return arg.slice('-c='.length);
  }
  if (arg.startsWith('-c')) {
    return arg.slice('-c'.length);
  }
  return undefined;
}
