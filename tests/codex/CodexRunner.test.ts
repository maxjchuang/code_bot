import { describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexSessionId, PtyCodexRunner } from '../../src/codex/CodexRunner.js';

const CODEX_TUI_KEYMAP_ARGS = [
  '-c',
  'disable_paste_burst=true',
  '-c',
  'tui.keymap.global.submit="ctrl-x"',
  '-c',
  'tui.keymap.editor.insert_newline=["ctrl-j","shift-enter","alt-enter"]',
];

describe('CodexRunner helpers', () => {
  it('creates stable prefixed session ids', () => {
    expect(createCodexSessionId('abc123').startsWith('sess_abc123_')).toBe(true);
  });
});

describe('PtyCodexRunner', () => {
  function createFakeTerm() {
    const writes: string[] = [];
    const kill = vi.fn();
    let onDataHandler: ((text: string) => void) | undefined;
    let onExitHandler: ((event: { exitCode: number }) => void) | undefined;
    return {
      term: {
        write: (text: string) => {
          writes.push(text);
        },
        kill,
        onData: (handler: (text: string) => void) => {
          onDataHandler = handler;
        },
        onExit: (handler: (event: { exitCode: number }) => void) => {
          onExitHandler = handler;
        },
      },
      writes,
      kill,
      emitData: (text: string) => onDataHandler?.(text),
      emitExit: (exitCode: number) => onExitHandler?.({ exitCode }),
    };
  }

  function createFakeTermFactory() {
    const terms: ReturnType<typeof createFakeTerm>[] = [];
    const spawn = vi.fn(() => {
      const fake = createFakeTerm();
      terms.push(fake);
      return fake.term as any;
    });
    return { spawn, terms };
  }

  it('reports missing codex command through health check', async () => {
    const runner = new PtyCodexRunner({ command: 'definitely-missing-codex-command', defaultArgs: [] });
    await expect(runner.healthCheck()).resolves.toEqual({ ok: false, reason: 'Command not found: definitely-missing-codex-command' });
  });

  it('can spawn a real pty process', async () => {
    const runner = new PtyCodexRunner({ command: '/bin/echo', defaultArgs: ['hello'] });
    const output: string[] = [];
    const exitCode = await new Promise<number | undefined>((resolve, reject) => {
      runner
        .start({
          sessionId: 'sess-real-pty',
          cwd: process.cwd(),
          args: [],
          onOutput: (text) => output.push(text),
          onExit: resolve,
        })
        .catch(reject);
    });

    expect(exitCode).toBe(0);
    expect(output.join('')).toContain('hello');
  });

  it('checks executable for relative command containing slash', async () => {
    const originalCwd = process.cwd();
    const dir = await mkdtemp(join(tmpdir(), 'codex-runner-rel-'));
    const binDir = join(dir, 'bin');
    const cmdPath = join(binDir, 'codex');

    try {
      await mkdir(binDir, { recursive: true });
      await writeFile(cmdPath, '#!/bin/sh\nexit 0\n');
      await chmod(cmdPath, 0o755);
      process.chdir(dir);

      const runner = new PtyCodexRunner({ command: './bin/codex', defaultArgs: [] });
      await expect(runner.healthCheck()).resolves.toEqual({ ok: true });
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('starts session with expected spawn args and wires callbacks', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner(
      { command: 'codex', defaultArgs: ['run', '--json'] },
      { spawn } as any,
    );
    const onOutput = vi.fn();
    const onExit = vi.fn();

    await runner.start({
      sessionId: 'sess-1',
      cwd: '/tmp/project',
      args: ['--model', 'gpt-5'],
      onOutput,
      onExit,
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['run', '--json', '--model', 'gpt-5', ...CODEX_TUI_KEYMAP_ARGS],
      expect.objectContaining({
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: '/tmp/project',
        env: process.env,
      }),
    );

    fake.emitData('hello');
    expect(onOutput).toHaveBeenCalledWith('hello');

    fake.emitExit(7);
    expect(onExit).toHaveBeenCalledWith(7);
    await expect(runner.send('sess-1', 'ignored')).rejects.toThrow('Codex session is not running: sess-1');
  });

  it('sets CODEX_HOME for spawned Codex processes when configured', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const originalPath = process.env.PATH;
    process.env.PATH = '/usr/bin';
    const runner = new PtyCodexRunner(
      { command: 'codex', defaultArgs: [], codexHome: '/tmp/project/.code-bot/codex-home' },
      { spawn } as any,
    );

    try {
      await runner.start({
        sessionId: 'sess-codex-home',
        cwd: '/tmp/project',
        args: [],
        onOutput: vi.fn(),
        onExit: vi.fn(),
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({
          PATH: '/usr/bin',
          CODEX_HOME: '/tmp/project/.code-bot/codex-home',
        }),
      }),
    );
  });

  it('binds ctrl-x to the Codex global submit action', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner({ command: 'codex', defaultArgs: [] }, { spawn } as any);

    await runner.start({
      sessionId: 'sess-submit-keymap',
      cwd: '/tmp/project',
      args: [],
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    expect(spawn).toHaveBeenCalledTimes(1);
    const [, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(args).toContain('tui.keymap.global.submit="ctrl-x"');
    expect(args).not.toContain('tui.keymap.composer.submit="ctrl-x"');
  });

  it('uses configured terminal dimensions when spawning Codex', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner(
      { command: 'codex', defaultArgs: [], terminal: { cols: 100, rows: 30 } },
      { spawn } as any,
    );

    await runner.start({
      sessionId: 'sess_1',
      cwd: '/repo',
      args: [],
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      expect.any(Array),
      expect.objectContaining({ cols: 100, rows: 30 }),
    );
  });

  it('starts resumed session with codex resume and target after options', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner(
      { command: 'codex', defaultArgs: ['--ask-for-approval', 'on-request'] },
      { spawn } as any,
    );

    await runner.start({
      sessionId: 'sess-resume',
      cwd: '/tmp/project',
      args: ['--model', 'gpt-5'],
      mode: { kind: 'resume', target: '019e7f20-a667-7632-a808-c9595d77116e' },
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      [
        'resume',
        '--ask-for-approval',
        'on-request',
        '--model',
        'gpt-5',
        ...CODEX_TUI_KEYMAP_ARGS,
        '019e7f20-a667-7632-a808-c9595d77116e',
      ],
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('strips stale default model selections when session args provide model selections', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner(
      {
        command: 'codex',
        defaultArgs: [
          '--ask-for-approval',
          'on-request',
          '--model',
          'gpt-stale',
          '-c',
          'model_reasoning_effort="low"',
          '--sandbox',
          'workspace-write',
        ],
      },
      { spawn } as any,
    );

    await runner.start({
      sessionId: 'sess-model-defaults',
      cwd: '/tmp/project',
      args: ['--model', 'gpt-5', '-c', 'model_reasoning_effort="high"'],
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      [
        '--ask-for-approval',
        'on-request',
        '--sandbox',
        'workspace-write',
        '--model',
        'gpt-5',
        '-c',
        'model_reasoning_effort="high"',
        ...CODEX_TUI_KEYMAP_ARGS,
      ],
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('strips matching default model config forms only for explicit session overrides', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner(
      {
        command: 'codex',
        defaultArgs: [
          '--model=gpt-stale',
          '--config',
          'model="gpt-config-stale"',
          '-c=model_reasoning_effort="low"',
          '--config=profile="work"',
        ],
      },
      { spawn } as any,
    );

    await runner.start({
      sessionId: 'sess-model-config-defaults',
      cwd: '/tmp/project',
      args: ['-m=gpt-5-mini'],
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['-c=model_reasoning_effort="low"', '--config=profile="work"', '-m=gpt-5-mini', ...CODEX_TUI_KEYMAP_ARGS],
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('strips stale default reasoning selections when session args provide reasoning selections', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner(
      {
        command: 'codex',
        defaultArgs: [
          '-m',
          'gpt-default',
          '--config',
          'model_reasoning_effort="low"',
          '--search',
        ],
      },
      { spawn } as any,
    );

    await runner.start({
      sessionId: 'sess-reasoning-defaults',
      cwd: '/tmp/project',
      args: ['--config=model_reasoning_effort="high"'],
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    expect(spawn).toHaveBeenCalledWith(
      'codex',
      ['-m', 'gpt-default', '--search', '--config=model_reasoning_effort="high"', ...CODEX_TUI_KEYMAP_ARGS],
      expect.objectContaining({ cwd: '/tmp/project' }),
    );
  });

  it('rejects duplicate start for same session and only spawns once', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner({ command: 'codex', defaultArgs: [] }, { spawn } as any);
    const options = {
      sessionId: 'sess-dup',
      cwd: process.cwd(),
      args: [],
      onOutput: vi.fn(),
      onExit: vi.fn(),
    };

    await runner.start(options);
    await expect(runner.start(options)).rejects.toThrow('Codex session is already running: sess-dup');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('selects Codex CLI update prompts automatically', async () => {
    const fake = createFakeTerm();
    const spawn = vi.fn(() => fake.term as any);
    const runner = new PtyCodexRunner({ command: 'codex', defaultArgs: [] }, { spawn } as any);

    await runner.start({
      sessionId: 'sess-auto-update',
      cwd: process.cwd(),
      args: [],
      onOutput: vi.fn(),
      onExit: vi.fn(),
    });

    fake.emitData('✨ Update available! 0.142.0 -> 0.142.1\n');
    expect(fake.writes).toEqual([]);

    fake.emitData('› 1. Update now (runs `npm install -g @openai/codex`)\nPress enter to continue');
    expect(fake.writes).toEqual(['\r']);

    fake.emitData('› 1. Update now (runs `npm install -g @openai/codex`)\nPress enter to continue');
    expect(fake.writes).toEqual(['\r']);
  });

  it('restarts Codex after CLI update and reuses resume arguments', async () => {
    const factory = createFakeTermFactory();
    const runner = new PtyCodexRunner(
      { command: 'codex', defaultArgs: ['--ask-for-approval', 'on-request'] },
      { spawn: factory.spawn } as any,
    );
    const onExit = vi.fn();
    const onRestart = vi.fn();

    await runner.start({
      sessionId: 'sess-auto-update-resume',
      cwd: '/tmp/project',
      args: ['--model', 'gpt-5'],
      mode: { kind: 'resume', target: '019e7f20-a667-7632-a808-c9595d77116e' },
      onOutput: vi.fn(),
      onExit,
      onRestart,
    });

    factory.terms[0].emitData('Update available! 0.142.0 -> 0.142.1\nUpdate now\nPress enter to continue');
    factory.terms[0].emitData('Update ran successfully! Please restart Codex.');
    expect(factory.terms[0].kill).toHaveBeenCalledTimes(1);

    factory.terms[0].emitExit(0);

    expect(onExit).not.toHaveBeenCalled();
    expect(onRestart).toHaveBeenCalledWith({ reason: 'codex_cli_update' });
    expect(factory.spawn).toHaveBeenCalledTimes(2);
    expect(factory.spawn).toHaveBeenLastCalledWith(
      'codex',
      [
        'resume',
        '--ask-for-approval',
        'on-request',
        '--model',
        'gpt-5',
        ...CODEX_TUI_KEYMAP_ARGS,
        '019e7f20-a667-7632-a808-c9595d77116e',
      ],
      expect.objectContaining({ cwd: '/tmp/project' }),
    );

    factory.terms[1].emitData('resumed after update');
    factory.terms[1].emitExit(0);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('does not restart when resumed transcript contains stale update success text', async () => {
    const factory = createFakeTermFactory();
    const runner = new PtyCodexRunner({ command: 'codex', defaultArgs: [] }, { spawn: factory.spawn } as any);
    const onRestart = vi.fn();

    await runner.start({
      sessionId: 'sess-stale-update-text',
      cwd: '/tmp/project',
      args: [],
      mode: { kind: 'resume', target: '019e7f20-a667-7632-a808-c9595d77116e' },
      onOutput: vi.fn(),
      onExit: vi.fn(),
      onRestart,
    });

    factory.terms[0].emitData('Previous conversation said: Update ran successfully! Please restart Codex.');

    expect(factory.terms[0].kill).not.toHaveBeenCalled();
    expect(onRestart).not.toHaveBeenCalled();
    expect(factory.spawn).toHaveBeenCalledTimes(1);
  });

  it('submits prompts by writing the configured control-key submit sequence after a short delay', async () => {
    vi.useFakeTimers();
    try {
      const fake = createFakeTerm();
      const spawn = vi.fn(() => fake.term as any);
      const runner = new PtyCodexRunner({ command: 'codex', defaultArgs: [] }, { spawn } as any);

      await runner.start({
        sessionId: 'sess-send-stop',
        cwd: process.cwd(),
        args: [],
        onOutput: vi.fn(),
        onExit: vi.fn(),
      });

      const sendPromise = runner.send('sess-send-stop', 'ping');
      expect(fake.writes).toEqual(['ping']);

      await vi.advanceTimersByTimeAsync(9);
      expect(fake.writes).toEqual(['ping']);

      await vi.advanceTimersByTimeAsync(1);
      await sendPromise;
      expect(fake.writes).toEqual(['ping', '\x18']);

      await runner.stop('sess-send-stop');
      expect(fake.kill).toHaveBeenCalledTimes(1);
      await expect(runner.send('sess-send-stop', 'again')).rejects.toThrow('Codex session is not running: sess-send-stop');
    } finally {
      vi.useRealTimers();
    }
  });
});
