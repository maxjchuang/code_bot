import { constants } from 'node:fs';
import { access, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type CodexHomeConfigInitStatus = 'existing' | 'copied' | 'missing-default';

export interface CodexHomeInitializationResult {
  codexHome: string;
  configToml: CodexHomeConfigInitStatus;
  copiedFrom?: string;
}

export interface CodexHomeInitializationOptions {
  projectRoot: string;
  defaultCodexHome?: string;
}

export function resolveProjectCodexHome(projectRoot: string): string {
  return join(projectRoot, '.code-bot/codex-home');
}

export async function initializeProjectCodexHome(options: CodexHomeInitializationOptions): Promise<CodexHomeInitializationResult> {
  const codexHome = resolveProjectCodexHome(options.projectRoot);
  await mkdir(codexHome, { recursive: true });

  const localConfig = join(codexHome, 'config.toml');
  if (await pathExists(localConfig)) {
    return { codexHome, configToml: 'existing' };
  }

  const defaultConfig = join(options.defaultCodexHome ?? defaultUserCodexHome(), 'config.toml');
  if (!(await pathExists(defaultConfig))) {
    return { codexHome, configToml: 'missing-default' };
  }

  await copyFile(defaultConfig, localConfig);
  return { codexHome, configToml: 'copied', copiedFrom: defaultConfig };
}

function defaultUserCodexHome(): string {
  return join(process.env.HOME ?? '', '.codex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
