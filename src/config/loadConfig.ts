import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BotConfig, ProjectConfig } from '../domain/types.js';
import { parseLogLevel } from '../logging/AppLogger.js';

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
    },
    codex: {
      command: requireString(codex.command, 'codex.command'),
      defaultArgs: codex.defaultArgs === undefined ? [] : requireStringArray(codex.defaultArgs, 'codex.defaultArgs'),
    },
    logLevel: optionalLogLevel(record.logLevel, 'info', 'logLevel'),
    ui: {
      verbosity: ui.verbosity === undefined ? 'normal' : requireUiVerbosity(ui.verbosity, 'ui.verbosity'),
    },
    notifications: {
      enabled: optionalBoolean(notifications.enabled, true, 'notifications.enabled'),
      idleMs: optionalPositiveNumber(notifications.idleMs, 3000, 'notifications.idleMs'),
      maxFinalChars: optionalPositiveNumber(notifications.maxFinalChars, 8000, 'notifications.maxFinalChars'),
      failureTailChars: optionalPositiveNumber(notifications.failureTailChars, 2000, 'notifications.failureTailChars'),
    },
  };
}

function requireUiVerbosity(value: unknown, field: string): 'normal' | 'debug' {
  if (value === 'normal' || value === 'debug') {
    return value;
  }
  throw new Error(`Invalid config field: ${field}`);
}
