# Self Upgrade Design

## Goal

Allow an authorized Feishu user to tell the running code bot to upgrade itself after code changes have been merged to `main`. The first version is a manual `/upgrade` command that fetches `origin/main`, installs dependencies, builds the project, and asks pm2 to restart the bot process.

## Current Behavior

The bot can modify this repository through Codex sessions and can create PRs, but the running service does not update itself after those PRs are merged. Deployment is manual: an operator must pull the latest code, run dependency/build commands, and restart the process. The repository has `npm run dev` and `npm start`, but no built-in supervisor or self-update command.

## Target Behavior

`/upgrade` triggers a guarded upgrade workflow:

1. Verify self-upgrade is enabled in config.
2. Verify the Feishu sender is listed in `upgrade.adminUsers`.
3. Verify the repository worktree is clean.
4. Fetch `origin main`.
5. Compare the current `HEAD` with `origin/main`.
6. If already current, reply that no upgrade is needed.
7. Check out `main` and fast-forward to `origin/main`.
8. Run `npm install`.
9. Run `npm run build`.
10. Record an upgrade event with old commit, new commit, and command outcomes.
11. Reply that the bot is about to restart.
12. Invoke a pm2 restart command for the configured process name.

The command should be synchronous until the restart step: users should receive explicit failure messages for permission, dirty worktree, git, install, and build failures. The restart step may terminate the current process, so the bot should send its final message before invoking pm2.

## Configuration

Add an `upgrade` config section:

- `upgrade.enabled`: boolean, default false.
- `upgrade.adminUsers`: Feishu open_id allowlist. Required and non-empty when upgrade is enabled.
- `upgrade.pm2ProcessName`: pm2 process name, default `code-bot`.
- `upgrade.remote`: git remote name, default `origin`.
- `upgrade.branch`: branch name, default `main`.

This is intentionally separate from `allowedUsers`. A user may be allowed to operate Codex sessions without being allowed to replace and restart the bot service.

## Architecture

Add `/upgrade` to command parsing and route it from `SessionManager` to a focused `UpgradeManager`.

`UpgradeManager` should depend on a small command runner abstraction rather than directly calling `child_process` everywhere. This keeps git/npm/pm2 orchestration testable and makes failure cases deterministic.

The manager should implement the workflow as explicit steps with structured results:

- `disabled`
- `unauthorized`
- `dirty-worktree`
- `already-current`
- `failed`
- `restart-triggered`

The manager should return a user-facing message for every status. It should also expose structured event data that `SessionManager` can persist through the existing `FileStateStore.appendEvent` path.

The restart command should be invoked through pm2, for example `pm2 restart <processName>`. It should be isolated behind the same command runner so tests can assert the restart would be called without restarting the test process.

## Git Behavior

The first version should only support a clean worktree. If the working tree has staged, unstaged, or untracked changes, `/upgrade` must refuse to run. This avoids overwriting local work and avoids mixing deployment with development branches.

The update should use a fast-forward-only main update. It should not merge, rebase, or force reset automatically. A safe sequence is:

- `git status --porcelain`
- `git fetch <remote> <branch>`
- `git rev-parse HEAD`
- `git rev-parse <remote>/<branch>`
- if equal, return already-current
- `git checkout <branch>`
- `git merge --ff-only <remote>/<branch>`

If checkout or fast-forward fails, the command should report the failure and stop before `npm install`.

## Error Handling

Any failed step before restart should stop the workflow and reply with the failed step and a short error summary.

If `npm install` fails, do not run build and do not restart.

If `npm run build` fails, do not restart.

If pm2 restart command fails, record the failure and reply with the error if the process is still alive. If the process exits during restart, the last successful user-visible message should already have been sent.

## Operational Requirements

The bot must be managed by pm2 for `/upgrade` to complete the restart step. Operators should start it with a stable process name matching `upgrade.pm2ProcessName`, for example:

```bash
npm run build
pm2 start dist/index.js --name code-bot
```

The command should not call `process.exit()` itself. pm2 is responsible for stopping and starting the process.

## Testing

Add config tests for the `upgrade` section defaults and validation.

Add command parser tests for `/upgrade`.

Add `UpgradeManager` unit tests for disabled, unauthorized, dirty worktree, already-current, install failure, build failure, and successful restart-triggered flow.

Add `SessionManager` tests proving `/upgrade` calls the manager and returns the manager's user-facing reply.

Add build-level tests or mocks proving pm2 restart is only invoked after fetch, fast-forward, install, and build all succeed.

## Non-Goals

This first version does not implement GitHub webhooks.

This first version does not poll `main` automatically.

This first version does not merge PRs itself.

This first version does not handle rollback after a bad restart. Rollback can be added later once the deployment primitive is stable.

This first version does not run arbitrary user-provided shell commands.

## Open Risks

If the bot is not actually managed by pm2, `/upgrade` can update and build the repository but cannot reliably restart the service.

If the new version has a startup-time bug that passes TypeScript build, pm2 may restart into a broken service. A future version should add health-check based restart verification and rollback.

If long-running Codex sessions exist during restart, they may be interrupted. The existing startup recovery behavior should mark stale sessions interrupted and attempt resume where possible, but this should be communicated in the `/upgrade` reply.
