# PM2 Upgrade Restart Target Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restart the exact current `code-bot` PM2 process and send upgrade/restart success prompts before the self-restart.

**Architecture:** Add PM2 target resolution inside `UpgradeManager`, using current PM2 id first and `pm2 jlist` path matching as fallback. Add an optional pre-restart callback so `SessionManager` can send the success prompt before invoking `pm2 restart`.

**Tech Stack:** TypeScript, Vitest, existing `UpgradeManager` and `SessionManager` tests.

---

## File Structure

- Modify `src/upgrade/UpgradeManager.ts`: add PM2 target resolution and pre-restart callback.
- Modify `src/session/SessionManager.ts`: wire pre-restart notification to the Feishu notifier.
- Modify `tests/upgrade/UpgradeManager.test.ts`: add PM2 target and pre-restart prompt tests.
- Modify `tests/session/SessionManager.test.ts`: verify `/upgrade` suppresses duplicate command reply after pre-restart notification.

## Tasks

- [x] Add failing tests for PM2 target resolution and pre-restart prompt.
- [x] Implement `UpgradeManager` PM2 id resolution.
- [x] Implement optional pre-restart prompt callback and duplicate-reply suppression.
- [x] Wire `SessionManager` to send the pre-restart prompt to the incoming message target.
- [x] Run focused tests, full upgrade/session tests, build, and review diff.

## Verification Notes

- `npm test -- tests/upgrade/UpgradeManager.test.ts`: passed.
- `npm test -- tests/session/SessionManager.test.ts -t "routes /upgrade|sends upgrade restart prompts|routes /restart"`: passed.
- `npm test -- tests/session/SessionManager.test.ts -t "caps live status chunks collected from terminal redraw output"`: passed when rerun alone.
- `npm run build`: passed.
- `npm test`: ran full suite; upgrade-related tests passed, but the existing `caps live status chunks collected from terminal redraw output` flaky failed in the full run.
