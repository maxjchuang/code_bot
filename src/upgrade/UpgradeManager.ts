import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpgradeConfig } from '../domain/types.js';

const execFileAsync = promisify(execFile);

export interface UpgradeCommandRunner {
  run(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }>;
}

export class NodeUpgradeCommandRunner implements UpgradeCommandRunner {
  async run(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd: options.cwd,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  }
}

export type UpgradeResult =
  | { status: 'disabled'; reply: string; event: Record<string, unknown> }
  | { status: 'unauthorized'; reply: string; event: Record<string, unknown> }
  | { status: 'dirty-worktree'; reply: string; event: Record<string, unknown> }
  | { status: 'already-current'; reply: string; oldCommit: string; newCommit: string; event: Record<string, unknown> }
  | {
      status: 'failed';
      reply: string;
      failedStep: string;
      error: string;
      oldCommit?: string;
      newCommit?: string;
      event: Record<string, unknown>;
    }
  | { status: 'restart-triggered'; reply: string; oldCommit: string; newCommit: string; event: Record<string, unknown> };

export interface UpgradeManagerDeps {
  projectRoot: string;
  config: UpgradeConfig;
  runner?: UpgradeCommandRunner;
}

type StepResult = { ok: true; stdout: string; stderr: string } | { ok: false; error: string };

export class UpgradeManager {
  private readonly runner: UpgradeCommandRunner;

  constructor(private readonly deps: UpgradeManagerDeps) {
    this.runner = deps.runner ?? new NodeUpgradeCommandRunner();
  }

  async upgrade(input: { userId: string }): Promise<UpgradeResult> {
    const config = this.deps.config;
    if (!config.enabled) {
      return simpleResult('disabled', 'Self-upgrade is disabled.', { enabled: false });
    }
    if (!config.adminUsers.includes(input.userId)) {
      return simpleResult('unauthorized', 'You are not allowed to run /upgrade.', { userId: input.userId });
    }

    const dirty = await this.runStep('git-status', 'git', ['status', '--porcelain']);
    if (!dirty.ok) {
      return failedResult('git-status', dirty.error);
    }
    if (dirty.stdout.trim() !== '') {
      return {
        status: 'dirty-worktree',
        reply: 'Cannot upgrade: repository worktree is not clean.',
        event: { status: 'dirty-worktree', dirtyPreview: preview(dirty.stdout) },
      };
    }

    const fetched = await this.runStep('git-fetch', 'git', ['fetch', config.remote, config.branch]);
    if (!fetched.ok) {
      return failedResult('git-fetch', fetched.error);
    }

    const head = await this.runStep('git-head', 'git', ['rev-parse', 'HEAD']);
    if (!head.ok) {
      return failedResult('git-head', head.error);
    }

    const remoteRef = `${config.remote}/${config.branch}`;
    const remote = await this.runStep('git-remote-head', 'git', ['rev-parse', remoteRef]);
    if (!remote.ok) {
      return failedResult('git-remote-head', remote.error);
    }

    const oldCommit = head.stdout.trim();
    const newCommit = remote.stdout.trim();
    if (oldCommit === newCommit) {
      return {
        status: 'already-current',
        reply: `Already up to date at ${shortSha(oldCommit)}.`,
        oldCommit,
        newCommit,
        event: { status: 'already-current', oldCommit, newCommit },
      };
    }

    const steps: Array<{ step: string; command: string; args: string[] }> = [
      { step: 'git-checkout', command: 'git', args: ['checkout', config.branch] },
      { step: 'git-fast-forward', command: 'git', args: ['merge', '--ff-only', remoteRef] },
      { step: 'npm-install', command: 'npm', args: ['install'] },
      { step: 'npm-build', command: 'npm', args: ['run', 'build'] },
      { step: 'pm2-restart', command: 'pm2', args: ['restart', config.pm2ProcessName] },
    ];

    for (const { step, command, args } of steps) {
      const result = await this.runStep(step, command, args);
      if (!result.ok) {
        return failedResult(step, result.error, { oldCommit, newCommit });
      }
    }

    return {
      status: 'restart-triggered',
      reply: `Upgrade installed ${shortSha(newCommit)}. Restarting ${config.pm2ProcessName} with pm2.`,
      oldCommit,
      newCommit,
      event: { status: 'restart-triggered', oldCommit, newCommit, pm2ProcessName: config.pm2ProcessName },
    };
  }

  private async runStep(step: string, command: string, args: string[]): Promise<StepResult> {
    try {
      const result = await this.runner.run(command, args, { cwd: this.deps.projectRoot });
      return { ok: true, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

function simpleResult<TStatus extends 'disabled' | 'unauthorized'>(
  status: TStatus,
  reply: string,
  event: Record<string, unknown>,
): Extract<UpgradeResult, { status: TStatus }> {
  return { status, reply, event: { status, ...event } } as Extract<UpgradeResult, { status: TStatus }>;
}

function failedResult(
  failedStep: string,
  error: string,
  data: { oldCommit?: string; newCommit?: string } = {},
): Extract<UpgradeResult, { status: 'failed' }> {
  return {
    status: 'failed',
    failedStep,
    error,
    reply: `Upgrade failed at ${failedStep}: ${error}`,
    oldCommit: data.oldCommit,
    newCommit: data.newCommit,
    event: { status: 'failed', failedStep, error, ...data },
  };
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function preview(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}
