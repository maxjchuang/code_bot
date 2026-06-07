import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BotConfig, ProjectConfig } from '../domain/types.js';
import { parseLogLevel } from '../logging/AppLogger.js';
import { DEFAULT_DISPLAY_TIME_ZONE, isValidDisplayTimeZone } from '../output/DisplayTimeFormatter.js';

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function optionalStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  return requireStringArray(value, field);
}

function optionalString(value: unknown, defaultValue: string, field: string): string {
  if (value === undefined) {
    return defaultValue;
  }
  return requireString(value, field);
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function optionalBoolean(value: unknown, defaultValue: boolean, field: string): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) {
    return defaultValue;
  }
  return requirePositiveNumber(value, field);
}

function optionalLogLevel(value: unknown, defaultValue: BotConfig['logLevel'], field: string): BotConfig['logLevel'] {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid config field: ${field}`);
  }
  const parsed = parseLogLevel(value);
  if (parsed !== value.trim().toLowerCase()) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return parsed;
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value as Record<string, unknown>;
}

function normalizeProject(value: unknown, projectRoot: string): ProjectConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid config field: projects');
  }
  const item = value as Record<string, unknown>;
  return {
    id: requireString(item.id, 'projects[].id'),
    name: requireString(item.name, 'projects[].name'),
    path: resolve(projectRoot, requireString(item.path, 'projects[].path')),
    codexArgs: item.codexArgs === undefined ? [] : requireStringArray(item.codexArgs, 'projects[].codexArgs'),
  };
}

function normalizeTerminalSnapshot(value: unknown): BotConfig['output']['terminalSnapshot'] {
  const record = optionalRecord(value, 'output.terminalSnapshot');
  return {
    cols: optionalPositiveNumber(record.cols, 120, 'output.terminalSnapshot.cols'),
    rows: optionalPositiveNumber(record.rows, 40, 'output.terminalSnapshot.rows'),
    scrollback: optionalPositiveNumber(record.scrollback, 200, 'output.terminalSnapshot.scrollback'),
    replayMaxBytes: optionalPositiveNumber(record.replayMaxBytes, 262144, 'output.terminalSnapshot.replayMaxBytes'),
    cardMaxRows: optionalPositiveNumber(record.cardMaxRows, 40, 'output.terminalSnapshot.cardMaxRows'),
    cardMaxLineChars: optionalPositiveNumber(record.cardMaxLineChars, 160, 'output.terminalSnapshot.cardMaxLineChars'),
    maxStyledSegmentsPerLine: optionalPositiveNumber(
      record.maxStyledSegmentsPerLine,
      8,
      'output.terminalSnapshot.maxStyledSegmentsPerLine',
    ),
  };
}

export async function loadConfig(projectRoot: string): Promise<BotConfig> {
  const raw = JSON.parse(await readFile(resolve(projectRoot, '.code-bot/config.json'), 'utf8')) as unknown;
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Invalid config structure');
  }
  const record = raw as Record<string, unknown>;
  const feishu = record.feishu as Record<string, unknown> | undefined;
  const output = record.output as Record<string, unknown> | undefined;
  const codex = record.codex as Record<string, unknown> | undefined;
  const ui = optionalRecord(record.ui, 'ui');
  const notifications = optionalRecord(record.notifications, 'notifications');
  const upgrade = optionalRecord(record.upgrade, 'upgrade');
  if (!feishu || !output || !codex || !Array.isArray(record.projects)) {
    throw new Error('Invalid config structure');
  }

  const projects = record.projects.map((project) => normalizeProject(project, projectRoot));
  const ids = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id)) {
      throw new Error(`Duplicate project id: ${project.id}`);
    }
    ids.add(project.id);
  }

  return {
    feishu: {
      appId: requireString(feishu.appId, 'feishu.appId'),
      appSecret: requireString(feishu.appSecret, 'feishu.appSecret'),
    },
    restrictUsers: optionalBoolean(record.restrictUsers, false, 'restrictUsers'),
    restrictChatIds: optionalBoolean(record.restrictChatIds, false, 'restrictChatIds'),
    allowedUsers: optionalStringArray(record.allowedUsers, 'allowedUsers'),
    allowedChatIds: optionalStringArray(record.allowedChatIds, 'allowedChatIds'),
    projects,
    output: {
      directMaxChars: requirePositiveNumber(output.directMaxChars, 'output.directMaxChars'),
      chunkSize: requirePositiveNumber(output.chunkSize, 'output.chunkSize'),
      terminalSnapshot: normalizeTerminalSnapshot(output.terminalSnapshot),
    },
    codex: {
      command: requireString(codex.command, 'codex.command'),
      defaultArgs: codex.defaultArgs === undefined ? [] : requireStringArray(codex.defaultArgs, 'codex.defaultArgs'),
    },
    logLevel: optionalLogLevel(record.logLevel, 'info', 'logLevel'),
    ui: {
      verbosity: ui.verbosity === undefined ? 'normal' : requireUiVerbosity(ui.verbosity, 'ui.verbosity'),
      currentRenderMode:
        ui.currentRenderMode === undefined
          ? 'markdown'
          : requireCurrentRenderMode(ui.currentRenderMode, 'ui.currentRenderMode'),
      timeZone:
        ui.timeZone === undefined ? DEFAULT_DISPLAY_TIME_ZONE : requireDisplayTimeZone(ui.timeZone, 'ui.timeZone'),
    },
    notifications: {
      enabled: optionalBoolean(notifications.enabled, true, 'notifications.enabled'),
      idleMs: optionalPositiveNumber(notifications.idleMs, 3000, 'notifications.idleMs'),
      maxFinalChars: optionalPositiveNumber(notifications.maxFinalChars, 8000, 'notifications.maxFinalChars'),
      failureTailChars: optionalPositiveNumber(notifications.failureTailChars, 2000, 'notifications.failureTailChars'),
    },
    upgrade: normalizeUpgrade(upgrade),
  };
}

function requireUiVerbosity(value: unknown, field: string): 'normal' | 'debug' {
  if (value === 'normal' || value === 'debug') {
    return value;
  }
  throw new Error(`Invalid config field: ${field}`);
}

function requireCurrentRenderMode(value: unknown, field: string): 'markdown' | 'code' {
  if (value === 'markdown' || value === 'code') {
    return value;
  }
  throw new Error(`Invalid config field: ${field}`);
}

function requireDisplayTimeZone(value: unknown, field: string): string {
  const timeZone = requireString(value, field);
  if (!isValidDisplayTimeZone(timeZone)) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return timeZone;
}

function normalizeUpgrade(value: Record<string, unknown>): BotConfig['upgrade'] {
  const upgrade = {
    enabled: optionalBoolean(value.enabled, false, 'upgrade.enabled'),
    adminUsers: optionalStringArray(value.adminUsers, 'upgrade.adminUsers'),
    pm2ProcessName: optionalString(value.pm2ProcessName, 'code-bot', 'upgrade.pm2ProcessName'),
    remote: optionalString(value.remote, 'origin', 'upgrade.remote'),
    branch: optionalString(value.branch, 'main', 'upgrade.branch'),
  };
  if (upgrade.enabled && upgrade.adminUsers.length === 0) {
    throw new Error('Invalid config field: upgrade.adminUsers');
  }
  return upgrade;
}
