# PM2 Upgrade Restart Target Design

## Goal

Make `/upgrade` and `/restart` restart the correct `code-bot` PM2 process when multiple similarly named processes exist, and make the success/restart prompt observable before the current process restarts.

## Root Cause

`UpgradeManager` currently executes `pm2 restart <pm2ProcessName>`, which is ambiguous when more than one process has the same name. It also returns the success message only after `pm2 restart`, so a successful self-restart can replace the process before Feishu sends the reply.

## Design

Before restarting, `UpgradeManager` resolves a concrete PM2 id:

1. Use the current process PM2 id when available.
2. Otherwise run `pm2 jlist` and filter by configured process name plus normalized project root / exec path.
3. Restart with `pm2 restart <pm_id>`.
4. Fail with a clear `pm2-target` error when no unique process can be resolved.

Before invoking `pm2 restart`, `UpgradeManager` calls an optional `beforeRestart` callback with the success message. `SessionManager` wires that callback to the notifier for real `/upgrade` and `/restart` commands. If the callback succeeds, the normal command reply is suppressed to avoid duplicate messages if the old process survives long enough to return.

## Testing

Unit tests cover current `pm_id`, PM2 list matching by path, no-match failure, ambiguous-match failure, and pre-restart prompt delivery. Existing success tests are updated to assert `pm2 restart <pm_id>` rather than `pm2 restart code-bot`.
