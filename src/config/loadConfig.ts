import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BotConfig, ProjectConfig } from '../domain/types.js';

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

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid config field: ${field}`);
  }
  return value;
}

function normalizeProject(value: unknown): ProjectConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Invalid config field: projects');
  }
  const item = value as Record<string, unknown>;
  return {
    id: requireString(item.id, 'projects[].id'),
    name: requireString(item.name, 'projects[].name'),
    path: resolve(requireString(item.path, 'projects[].path')),
    codexArgs: item.codexArgs === undefined ? [] : requireStringArray(item.codexArgs, 'projects[].codexArgs'),
  };
}

export async function loadConfig(projectRoot: string): Promise<BotConfig> {
  const raw = JSON.parse(await readFile(resolve(projectRoot, '.code-bot/config.json'), 'utf8')) as Record<string, unknown>;
  const feishu = raw.feishu as Record<string, unknown> | undefined;
  const output = raw.output as Record<string, unknown> | undefined;
  const codex = raw.codex as Record<string, unknown> | undefined;
  if (!feishu || !output || !codex || !Array.isArray(raw.projects)) {
    throw new Error('Invalid config structure');
  }

  const projects = raw.projects.map(normalizeProject);
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
    allowedUsers: requireStringArray(raw.allowedUsers, 'allowedUsers'),
    allowedChatIds: requireStringArray(raw.allowedChatIds, 'allowedChatIds'),
    projects,
    output: {
      directMaxChars: requirePositiveNumber(output.directMaxChars, 'output.directMaxChars'),
      chunkSize: requirePositiveNumber(output.chunkSize, 'output.chunkSize'),
    },
    codex: {
      command: requireString(codex.command, 'codex.command'),
      defaultArgs: codex.defaultArgs === undefined ? [] : requireStringArray(codex.defaultArgs, 'codex.defaultArgs'),
    },
  };
}
