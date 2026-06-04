# Self Upgrade Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an admin-only `/upgrade` command that safely pulls `origin/main`, installs dependencies, builds, and asks pm2 to restart the bot.

**Architecture:** Add upgrade config to `BotConfig`, a focused `UpgradeManager` with an injectable command runner, and route `/upgrade` from `SessionManager`. Keep process restart outside Node lifecycle control by invoking `pm2 restart <processName>` only after all validation, git, install, and build steps succeed.

**Tech Stack:** TypeScript, Vitest, Node `child_process.execFile`, existing `SessionManager`, `FileStateStore`, and config loader.

---

## File Structure

- Modify `src/domain/types.ts`: add `UpgradeConfig` and `BotConfig.upgrade`.
- Modify `src/config/loadConfig.ts`: parse and validate `upgrade`.
- Modify `config.example.json`: document disabled default upgrade config.
- Modify `tests/config/loadConfig.test.ts`: cover defaults and validation.
- Modify `tests/helpers/fakes.ts`: add `upgrade` defaults to `sampleConfig`.
- Modify `src/commands/CommandRouter.ts`: include `upgrade` in `CommandName`.
- Modify `tests/commands/CommandRouter.test.ts`: add `/upgrade` parser test.
- Create `src/upgrade/UpgradeManager.ts`: implement guarded upgrade workflow and command runner.
- Create `tests/upgrade/UpgradeManager.test.ts`: test workflow outcomes and command ordering.
- Modify `src/session/SessionManager.ts`: add dependency injection and `/upgrade` handling.
- Modify `src/app/createApp.ts`: construct and inject the default `UpgradeManager`.
- Modify `tests/session/SessionManager.test.ts`: verify `/upgrade` dispatch.
- Modify `tests/app/createApp.test.ts`: verify dependency wiring if needed.
- Modify `README.md`: document pm2 startup and `/upgrade`.

## Task 1: Upgrade Config Schema

**Files:**
- Modify: `src/domain/types.ts`
- Modify: `src/config/loadConfig.ts`
- Modify: `config.example.json`
- Modify: `tests/helpers/fakes.ts`
- Test: `tests/config/loadConfig.test.ts`

- [ ] **Step 1: Write failing config tests**

Add to `tests/config/loadConfig.test.ts`:

```ts
it('defaults upgrade config to disabled with safe defaults', async () => {
  const root = await createTmpDir();
  await writeConfig(root, validConfig());

  await expect(loadConfig(root)).resolves.toMatchObject({
    upgrade: {
      enabled: false,
      adminUsers: [],
      pm2ProcessName: 'code-bot',
      remote: 'origin',
      branch: 'main',
    },
  });
});

it('loads explicit upgrade config', async () => {
  const root = await createTmpDir();
  await writeConfig(
    root,
    validConfig({
      upgrade: {
        enabled: true,
        adminUsers: ['ou_admin'],
        pm2ProcessName: 'code-bot-prod',
        remote: 'upstream',
        branch: 'stable',
      },
    }),
  );

  await expect(loadConfig(root)).resolves.toMatchObject({
    upgrade: {
      enabled: true,
      adminUsers: ['ou_admin'],
      pm2ProcessName: 'code-bot-prod',
      remote: 'upstream',
      branch: 'stable',
    },
  });
});

it('rejects enabled upgrade config without admin users', async () => {
  const root = await createTmpDir();
  await writeConfig(root, validConfig({ upgrade: { enabled: true, adminUsers: [] } }));

  await expect(loadConfig(root)).rejects.toThrow('Invalid config field: upgrade.adminUsers');
});

it('rejects malformed upgrade container', async () => {
  const root = await createTmpDir();
  await writeConfig(root, validConfig({ upgrade: true }));

  await expect(loadConfig(root)).rejects.toThrow('Invalid config field: upgrade');
});
```

- [ ] **Step 2: Run config tests to verify failure**

Run:

```bash
npm test -- tests/config/loadConfig.test.ts
```

Expected: FAIL because `BotConfig` and `loadConfig()` do not expose `upgrade`.

- [ ] **Step 3: Add domain config types**

In `src/domain/types.ts`, add:

```ts
export interface UpgradeConfig {
  enabled: boolean;
  adminUsers: string[];
  pm2ProcessName: string;
  remote: string;
  branch: string;
}
```

Add to `BotConfig`:

```ts
upgrade: UpgradeConfig;
```

- [ ] **Step 4: Parse upgrade config**

In `src/config/loadConfig.ts`, add:

```ts
function requireNonEmptyStringArrayWhenEnabled(value: unknown, enabled: boolean, field: string): string[] {
  const items = optionalStringArray(value, field);
  if (enabled && items.length === 0) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return items;
}
```

Inside `loadConfig()`, after `notifications`:

```ts
const upgrade = optionalRecord(record.upgrade, 'upgrade');
const upgradeEnabled = optionalBoolean(upgrade.enabled, false, 'upgrade.enabled');
```

Return:

```ts
upgrade: {
  enabled: upgradeEnabled,
  adminUsers: requireNonEmptyStringArrayWhenEnabled(upgrade.adminUsers, upgradeEnabled, 'upgrade.adminUsers'),
  pm2ProcessName: upgrade.pm2ProcessName === undefined ? 'code-bot' : requireString(upgrade.pm2ProcessName, 'upgrade.pm2ProcessName'),
  remote: upgrade.remote === undefined ? 'origin' : requireString(upgrade.remote, 'upgrade.remote'),
  branch: upgrade.branch === undefined ? 'main' : requireString(upgrade.branch, 'upgrade.branch'),
},
```

- [ ] **Step 5: Update test helpers and example config**

In `tests/helpers/fakes.ts`, add to `sampleConfig()`:

```ts
upgrade: { enabled: false, adminUsers: [], pm2ProcessName: 'code-bot', remote: 'origin', branch: 'main' },
```

In `config.example.json`, add:

```json
  "upgrade": {
    "enabled": false,
    "adminUsers": [],
    "pm2ProcessName": "code-bot",
    "remote": "origin",
    "branch": "main"
  },
```

- [ ] **Step 6: Run config tests**

Run:

```bash
npm test -- tests/config/loadConfig.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/domain/types.ts src/config/loadConfig.ts config.example.json tests/helpers/fakes.ts tests/config/loadConfig.test.ts
git commit -m "feat: add self upgrade config"
```

## Task 2: Command Parsing

**Files:**
- Modify: `src/commands/CommandRouter.ts`
- Test: `tests/commands/CommandRouter.test.ts`

- [ ] **Step 1: Write failing parser test**

Add to `tests/commands/CommandRouter.test.ts`:

```ts
it('parses /upgrade as a command', () => {
  expect(parseIncomingText('/upgrade')).toEqual({
    kind: 'command',
    name: 'upgrade',
    args: [],
    raw: '/upgrade',
  });
});
```

- [ ] **Step 2: Run command tests**

Run:

```bash
npm test -- tests/commands/CommandRouter.test.ts
```

Expected: PASS for parser behavior, but TypeScript will not know `upgrade` as a command enum until implementation.

- [ ] **Step 3: Add command name**

In `src/commands/CommandRouter.ts`, add `'upgrade'` to `CommandName`:

```ts
  | 'upgrade'
```

- [ ] **Step 4: Run command tests**

Run:

```bash
npm test -- tests/commands/CommandRouter.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/commands/CommandRouter.ts tests/commands/CommandRouter.test.ts
git commit -m "feat: parse upgrade command"
```

## Task 3: UpgradeManager Workflow

**Files:**
- Create: `src/upgrade/UpgradeManager.ts`
- Test: `tests/upgrade/UpgradeManager.test.ts`

- [ ] **Step 1: Write failing UpgradeManager tests**

Create `tests/upgrade/UpgradeManager.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { UpgradeManager, type UpgradeCommandRunner } from '../../src/upgrade/UpgradeManager.js';
import type { UpgradeConfig } from '../../src/domain/types.js';

function config(overrides: Partial<UpgradeConfig> = {}): UpgradeConfig {
  return {
    enabled: true,
    adminUsers: ['ou_admin'],
    pm2ProcessName: 'code-bot',
    remote: 'origin',
    branch: 'main',
    ...overrides,
  };
}

function runner(outputs: Record<string, string | Error> = {}): UpgradeCommandRunner & { calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  return {
    calls,
    run: vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
      const key = `${command} ${args.join(' ')}`;
      const output = outputs[key] ?? '';
      if (output instanceof Error) {
        throw output;
      }
      return { stdout: output, stderr: '' };
    }),
  };
}

describe('UpgradeManager', () => {
  it('rejects disabled upgrades', async () => {
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config({ enabled: false }), runner: runner() });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'disabled',
      reply: 'Self-upgrade is disabled.',
    });
  });

  it('rejects unauthorized users', async () => {
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: runner() });

    await expect(manager.upgrade({ userId: 'ou_other' })).resolves.toMatchObject({
      status: 'unauthorized',
      reply: 'You are not allowed to run /upgrade.',
    });
  });

  it('rejects dirty worktrees before fetch', async () => {
    const commandRunner = runner({ 'git status --porcelain': ' M src/index.ts\n' });
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'dirty-worktree',
    });
    expect(commandRunner.calls.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual(['git status --porcelain']);
  });

  it('returns already-current when HEAD equals remote branch', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'abc123\n',
      'git rev-parse origin/main': 'abc123\n',
    });
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'already-current',
    });
    expect(commandRunner.calls.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual([
      'git status --porcelain',
      'git fetch origin main',
      'git rev-parse HEAD',
      'git rev-parse origin/main',
    ]);
  });

  it('stops before build when npm install fails', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'old\n',
      'git rev-parse origin/main': 'new\n',
      'npm install': new Error('install failed'),
    });
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'npm-install',
    });
    expect(commandRunner.calls.map((call) => `${call.command} ${call.args.join(' ')}`)).not.toContain('npm run build');
  });

  it('stops before restart when build fails', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'old\n',
      'git rev-parse origin/main': 'new\n',
      'npm run build': new Error('build failed'),
    });
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'failed',
      failedStep: 'npm-build',
    });
    expect(commandRunner.calls.map((call) => `${call.command} ${call.args.join(' ')}`)).not.toContain('pm2 restart code-bot');
  });

  it('runs fast-forward, install, build, and pm2 restart on success', async () => {
    const commandRunner = runner({
      'git rev-parse HEAD': 'old\n',
      'git rev-parse origin/main': 'new\n',
    });
    const manager = new UpgradeManager({ projectRoot: '/repo', config: config(), runner: commandRunner });

    await expect(manager.upgrade({ userId: 'ou_admin' })).resolves.toMatchObject({
      status: 'restart-triggered',
      oldCommit: 'old',
      newCommit: 'new',
    });
    expect(commandRunner.calls.map((call) => `${call.command} ${call.args.join(' ')}`)).toEqual([
      'git status --porcelain',
      'git fetch origin main',
      'git rev-parse HEAD',
      'git rev-parse origin/main',
      'git checkout main',
      'git merge --ff-only origin/main',
      'npm install',
      'npm run build',
      'pm2 restart code-bot',
    ]);
  });
});
```

- [ ] **Step 2: Run UpgradeManager tests to verify failure**

Run:

```bash
npm test -- tests/upgrade/UpgradeManager.test.ts
```

Expected: FAIL because `src/upgrade/UpgradeManager.ts` does not exist.

- [ ] **Step 3: Implement UpgradeManager**

Create `src/upgrade/UpgradeManager.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { UpgradeConfig } from '../domain/types.js';

const execFileAsync = promisify(execFile);

export interface UpgradeCommandRunner {
  run(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }>;
}

export class NodeUpgradeCommandRunner implements UpgradeCommandRunner {
  async run(command: string, args: string[], options: { cwd: string }): Promise<{ stdout: string; stderr: string }> {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd: options.cwd, maxBuffer: 1024 * 1024 });
    return { stdout: String(stdout), stderr: String(stderr) };
  }
}

export type UpgradeResult =
  | { status: 'disabled'; reply: string; event: Record<string, unknown> }
  | { status: 'unauthorized'; reply: string; event: Record<string, unknown> }
  | { status: 'dirty-worktree'; reply: string; event: Record<string, unknown> }
  | { status: 'already-current'; reply: string; oldCommit: string; newCommit: string; event: Record<string, unknown> }
  | { status: 'failed'; reply: string; failedStep: string; error: string; event: Record<string, unknown> }
  | { status: 'restart-triggered'; reply: string; oldCommit: string; newCommit: string; event: Record<string, unknown> };

export interface UpgradeManagerDeps {
  projectRoot: string;
  config: UpgradeConfig;
  runner?: UpgradeCommandRunner;
}

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

    for (const [step, command, args] of [
      ['git-checkout', 'git', ['checkout', config.branch]],
      ['git-fast-forward', 'git', ['merge', '--ff-only', remoteRef]],
      ['npm-install', 'npm', ['install']],
      ['npm-build', 'npm', ['run', 'build']],
      ['pm2-restart', 'pm2', ['restart', config.pm2ProcessName]],
    ] as const) {
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

  private async runStep(step: string, command: string, args: string[]): Promise<{ ok: true; stdout: string; stderr: string } | { ok: false; error: string }> {
    try {
      return { ok: true, ...(await this.runner.run(command, args, { cwd: this.deps.projectRoot })) };
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

function failedResult(failedStep: string, error: string, data: Record<string, unknown> = {}): Extract<UpgradeResult, { status: 'failed' }> {
  return {
    status: 'failed',
    failedStep,
    error,
    reply: `Upgrade failed at ${failedStep}: ${error}`,
    event: { status: 'failed', failedStep, error, ...data },
  };
}

function shortSha(value: string): string {
  return value.slice(0, 7);
}

function preview(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}
```

- [ ] **Step 4: Run UpgradeManager tests**

Run:

```bash
npm test -- tests/upgrade/UpgradeManager.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/upgrade/UpgradeManager.ts tests/upgrade/UpgradeManager.test.ts
git commit -m "feat: add self upgrade manager"
```

## Task 4: SessionManager Integration

**Files:**
- Modify: `src/session/SessionManager.ts`
- Modify: `src/app/createApp.ts`
- Test: `tests/session/SessionManager.test.ts`
- Test if needed: `tests/app/createApp.test.ts`

- [ ] **Step 1: Write failing SessionManager tests**

Add to `tests/session/SessionManager.test.ts`:

```ts
it('routes /upgrade to the upgrade manager and records the result event', async () => {
  const root = await createTmpDir();
  const store = new FileStateStore(root, () => new Date('2026-06-04T00:00:00.000Z'));
  const runner = new FakeCodexRunner();
  const upgradeManager = {
    upgrade: vi.fn().mockResolvedValue({
      status: 'restart-triggered',
      reply: 'Upgrade installed abc1234. Restarting code-bot with pm2.',
      event: { status: 'restart-triggered', oldCommit: 'old', newCommit: 'abc1234' },
    }),
  };
  const config = {
    ...sampleConfig(root),
    upgrade: { enabled: true, adminUsers: ['ou_1'], pm2ProcessName: 'code-bot', remote: 'origin', branch: 'main' },
  };
  const manager = new SessionManager(config, store, runner, { upgradeManager });

  const result = await manager.handleText({ chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: '/upgrade', wasMentioned: true });

  expect(result.reply).toBe('Upgrade installed abc1234. Restarting code-bot with pm2.');
  expect(upgradeManager.upgrade).toHaveBeenCalledWith({ userId: 'ou_1' });
  const events = (await readFile(join(root, '.code-bot/events/2026-06-04.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'upgrade.completed',
      data: expect.objectContaining({ status: 'restart-triggered', oldCommit: 'old', newCommit: 'abc1234' }),
    }),
  );
});
```

- [ ] **Step 2: Run SessionManager test to verify failure**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "upgrade"
```

Expected: FAIL because `SessionManagerDeps` has no `upgradeManager` and `/upgrade` is unknown.

- [ ] **Step 3: Add upgrade dependency and command handling**

In `src/session/SessionManager.ts`, import:

```ts
import { UpgradeManager } from '../upgrade/UpgradeManager.js';
```

Add dependency shape:

```ts
upgradeManager?: Pick<UpgradeManager, 'upgrade'>;
```

Add a private accessor:

```ts
private upgradeManager(): Pick<UpgradeManager, 'upgrade'> {
  return this.deps.upgradeManager ?? new UpgradeManager({ projectRoot: process.cwd(), config: this.config.upgrade });
}
```

Add to command switch:

```ts
case 'upgrade':
  return this.upgrade(input);
```

Add method:

```ts
private async upgrade(input: IncomingBotText): Promise<BotTextResult> {
  const result = await this.upgradeManager().upgrade({ userId: input.userId });
  await this.store.appendEvent({
    type: result.status === 'restart-triggered' ? 'upgrade.completed' : 'upgrade.skipped',
    at: new Date().toISOString(),
    data: result.event,
  });
  return { reply: result.reply };
}
```

Add `/upgrade` to `helpText()`.

- [ ] **Step 4: Wire default manager through createApp**

In `src/app/createApp.ts`, import `UpgradeManager` and pass it to `SessionManager`:

```ts
import { UpgradeManager } from '../upgrade/UpgradeManager.js';
```

Inside `new SessionManager(... deps ...)`:

```ts
upgradeManager: new UpgradeManager({ projectRoot: deps.projectRoot, config: deps.config.upgrade }),
```

- [ ] **Step 5: Run session tests**

Run:

```bash
npm test -- tests/session/SessionManager.test.ts -t "upgrade"
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/session/SessionManager.ts src/app/createApp.ts tests/session/SessionManager.test.ts tests/app/createApp.test.ts
git commit -m "feat: wire upgrade command"
```

If `tests/app/createApp.test.ts` is unchanged, omit it from `git add`.

## Task 5: Documentation and Final Verification

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update README**

In `README.md`, add `/upgrade` to the command reference and add this operations section:

````md
## Self Upgrade

`/upgrade` lets an admin user pull the latest configured branch, install dependencies, build, and restart the bot through pm2.

Config:

```json
"upgrade": {
  "enabled": true,
  "adminUsers": ["ou_admin_open_id"],
  "pm2ProcessName": "code-bot",
  "remote": "origin",
  "branch": "main"
}
```

Run the bot under pm2:

```bash
npm run build
pm2 start dist/index.js --name code-bot
```

The command refuses to run on a dirty worktree and uses fast-forward-only git updates.
````

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test -- tests/config/loadConfig.test.ts tests/commands/CommandRouter.test.ts tests/upgrade/UpgradeManager.test.ts tests/session/SessionManager.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run full tests**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 4: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

Run:

```bash
git add README.md
git commit -m "docs: document upgrade command"
```

- [ ] **Step 6: Inspect branch**

Run:

```bash
git status --short
git log --oneline -8
```

Expected: clean worktree and recent commits for config, parser, manager, wiring, and docs.

## Self-Review

Spec coverage:

- Manual `/upgrade`: Task 2 parses it, Task 4 routes it.
- Admin-only: Task 1 config validates admin users, Task 3 manager enforces authorization.
- Clean worktree: Task 3 checks `git status --porcelain`.
- Fetch/compare/update: Task 3 covers fetch, rev-parse, checkout, fast-forward.
- `npm install` and build: Task 3 runs both and stops on failure.
- pm2 restart: Task 3 invokes `pm2 restart <processName>` only after all prior steps.
- Events: Task 4 records upgrade result events through `FileStateStore`.
- Docs: Task 5 documents pm2 operation and config.

Placeholder scan:

- No `TBD`, `TODO`, `FIXME`, or vague implementation-only steps are intentionally left in this plan.

Type consistency:

- `UpgradeConfig`, `UpgradeManager`, `UpgradeCommandRunner`, and `upgradeManager` dependency names are introduced before use and kept consistent across tasks.
