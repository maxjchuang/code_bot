import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { initializeProjectCodexHome, resolveProjectCodexHome } from '../../src/codex/CodexHome.js';
import { createTmpDir } from '../helpers/tmp.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

describe('CodexHome', () => {
  it('resolves to the project-local codex home and ignores CODEX_HOME', async () => {
    const root = await createTmpDir();
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/tmp/shared-codex-home';
    try {
      expect(resolveProjectCodexHome(root)).toBe(join(root, '.code-bot/codex-home'));
    } finally {
      if (original === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = original;
      }
    }
  });

  it('copies only default config.toml when local config is missing', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'default-codex');
    await mkdir(defaultHome, { recursive: true });
    await writeFile(join(defaultHome, 'config.toml'), 'model = "gpt-5.5"\n', 'utf8');
    await writeFile(join(defaultHome, 'hooks.json'), '{"hooks":{}}\n', 'utf8');

    const result = await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });

    expect(result).toEqual({
      codexHome: join(root, '.code-bot/codex-home'),
      configToml: 'copied',
      copiedFrom: join(defaultHome, 'config.toml'),
    });
    await expect(readFile(join(root, '.code-bot/codex-home/config.toml'), 'utf8')).resolves.toBe('model = "gpt-5.5"\n');
    await expect(exists(join(root, '.code-bot/codex-home/hooks.json'))).resolves.toBe(false);
  });

  it('does not overwrite an existing project-local config.toml', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'default-codex');
    const localHome = resolveProjectCodexHome(root);
    await mkdir(defaultHome, { recursive: true });
    await mkdir(localHome, { recursive: true });
    await writeFile(join(defaultHome, 'config.toml'), 'model = "default"\n', 'utf8');
    await writeFile(join(localHome, 'config.toml'), 'model = "local"\n', 'utf8');

    const result = await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });

    expect(result.configToml).toBe('existing');
    await expect(readFile(join(localHome, 'config.toml'), 'utf8')).resolves.toBe('model = "local"\n');
  });

  it('creates only the local directory when default config.toml is missing', async () => {
    const root = await createTmpDir();
    const defaultHome = join(root, 'missing-default-codex');

    const result = await initializeProjectCodexHome({ projectRoot: root, defaultCodexHome: defaultHome });

    expect(result).toEqual({
      codexHome: join(root, '.code-bot/codex-home'),
      configToml: 'missing-default',
    });
    await expect(exists(join(root, '.code-bot/codex-home'))).resolves.toBe(true);
    await expect(exists(join(root, '.code-bot/codex-home/config.toml'))).resolves.toBe(false);
  });

  it('resolves different project roots to different codex homes', async () => {
    const parent = await createTmpDir();
    expect(resolveProjectCodexHome(join(parent, 'a'))).toBe(join(parent, 'a/.code-bot/codex-home'));
    expect(resolveProjectCodexHome(join(parent, 'b'))).toBe(join(parent, 'b/.code-bot/codex-home'));
  });
});
