import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import pty from 'node-pty';

const SUBMIT_ENTER_DELAY_MS = 10;
const CODEX_UPDATE_BUFFER_MAX_CHARS = 8_192;
const CODEX_UPDATE_ENTER_SEQUENCE = '\r';
export const CODEX_TUI_SUBMIT_SEQUENCE = '\x18';
const CODEX_TUI_KEYMAP_ARGS = [
  '-c',
  'disable_paste_burst=true',
  '-c',
  'tui.keymap.global.submit="ctrl-x"',
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
  onRestart?: (event: CodexRestartEvent) => void | Promise<void>;
}

export interface CodexRestartEvent {
  reason: 'codex_cli_update';
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
  private readonly processes = new Map<string, RunningCodexProcess>();
  private versionPromise?: Promise<string | undefined>;

  constructor(
    private readonly config: {
      command: string;
      defaultArgs: string[];
      terminal?: { cols: number; rows: number };
    },
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
    const entry: RunningCodexProcess = {
      sessionId: options.sessionId,
      args,
      cwd: options.cwd,
      onOutput: options.onOutput,
      onExit: options.onExit,
      onRestart: options.onRestart,
      updateBuffer: '',
      updatePromptSubmitted: false,
      restartAfterUpdate: false,
      generation: 0,
    };
    this.processes.set(options.sessionId, entry);
    this.spawnProcess(entry);
  }

  private spawnProcess(entry: RunningCodexProcess): void {
    const generation = entry.generation + 1;
    entry.generation = generation;
    entry.updateBuffer = '';
    entry.updatePromptSubmitted = false;
    entry.restartAfterUpdate = false;
    const term = this.ptyModule.spawn(this.config.command, entry.args, {
      name: 'xterm-256color',
      cols: this.config.terminal?.cols ?? 120,
      rows: this.config.terminal?.rows ?? 40,
      cwd: entry.cwd,
      env: process.env,
    });
    entry.term = term;
    term.onData((text) => {
      entry.onOutput(text);
      this.handleCodexUpdateOutput(entry, text);
    });
    term.onExit((event) => {
      const current = this.processes.get(entry.sessionId);
      if (current !== entry || entry.generation !== generation) {
        return;
      }
      if (entry.restartAfterUpdate) {
        this.spawnProcess(entry);
        void Promise.resolve(entry.onRestart?.({ reason: 'codex_cli_update' }));
        return;
      }
      this.processes.delete(entry.sessionId);
      entry.onExit(event.exitCode);
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
    const entry = this.processes.get(sessionId);
    if (!entry?.term) {
      throw new Error(`Codex session is not running: ${sessionId}`);
    }
    return entry.term;
  }

  private handleCodexUpdateOutput(entry: RunningCodexProcess, text: string): void {
    entry.updateBuffer = (entry.updateBuffer + text).slice(-CODEX_UPDATE_BUFFER_MAX_CHARS);
    if (!entry.updatePromptSubmitted && isCodexUpdatePrompt(entry.updateBuffer)) {
      entry.updatePromptSubmitted = true;
      entry.term?.write(CODEX_UPDATE_ENTER_SEQUENCE);
    }
    if (!entry.restartAfterUpdate && entry.updatePromptSubmitted && isCodexUpdateSuccess(entry.updateBuffer)) {
      entry.restartAfterUpdate = true;
      entry.term?.kill();
    }
  }
}

interface RunningCodexProcess {
  sessionId: string;
  args: string[];
  cwd: string;
  onOutput: (text: string) => void;
  onExit: (exitCode: number | undefined) => void;
  onRestart?: (event: CodexRestartEvent) => void | Promise<void>;
  term?: pty.IPty;
  updateBuffer: string;
  updatePromptSubmitted: boolean;
  restartAfterUpdate: boolean;
  generation: number;
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

function isCodexUpdatePrompt(text: string): boolean {
  return text.includes('Update available!') && text.includes('Update now') && text.includes('Press enter to continue');
}

function isCodexUpdateSuccess(text: string): boolean {
  return text.includes('Update ran successfully! Please restart Codex.');
}
