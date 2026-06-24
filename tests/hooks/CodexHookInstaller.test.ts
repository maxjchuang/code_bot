import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexHookInstaller } from '../../src/hooks/CodexHookInstaller.js';
import { createTmpDir } from '../helpers/tmp.js';

async function pathExists(path: string): Promise<boolean> {
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

function createInstaller(codexHome: string, projectRoot: string): CodexHookInstaller {
  return new CodexHookInstaller({
    codexHome,
    projectRoot,
    socketPath: join(projectRoot, '.code-bot/codex-hooks.sock'),
    now: () => '2026-06-24T00:00:00.000Z',
  });
}

describe('CodexHookInstaller', () => {
  it('reports missing managed hooks in an empty codex home', async () => {
    const root = await createTmpDir();
    const codexHome = join(root, 'codex-home');

    const report = await createInstaller(codexHome, root).status();

    expect(report).toMatchObject({
      configFeatureEnabled: true,
      hooksJsonContainsManagedHooks: false,
      manifestValid: false,
      scriptInstalled: false,
    });
    expect(report.recommendedCommand).toBe('/install-hooks');
  });

  it('installs managed hook script, hooks.json, config marker, and manifest idempotently', async () => {
    const root = await createTmpDir();
    const codexHome = join(root, 'codex-home');
    const installer = createInstaller(codexHome, root);

    await expect(installer.install()).resolves.toMatchObject({ installed: true });
    await expect(installer.install()).resolves.toMatchObject({ installed: true });

    const scriptPath = join(codexHome, '.code-bot/codex-hooks/code_bot_hook.mjs');
    const manifestPath = join(codexHome, '.code-bot/codex-hooks/manifest.json');
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
    const configToml = await readFile(join(codexHome, 'config.toml'), 'utf8');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

    expect(await pathExists(scriptPath)).toBe(true);
    expect(configToml.match(/code_bot managed hooks enabled/g)).toHaveLength(1);
    expect(configToml).toContain('[features]\nhooks = true');
    expect(hooks.session_started).toEqual(expect.arrayContaining([expect.objectContaining({ command: expect.stringContaining(scriptPath) })]));
    expect(hooks.user_prompt_submitted).toEqual(expect.arrayContaining([expect.objectContaining({ command: expect.stringContaining(scriptPath) })]));
    expect(hooks.stop).toEqual(expect.arrayContaining([expect.objectContaining({ command: expect.stringContaining(scriptPath) })]));
    expect(manifest).toMatchObject({
      version: 1,
      managedFiles: ['.code-bot/codex-hooks/code_bot_hook.mjs'],
      managedHookEvents: ['session_started', 'user_prompt_submitted', 'stop'],
      installedAt: '2026-06-24T00:00:00.000Z',
    });
    await expect(installer.status()).resolves.toMatchObject({
      configFeatureEnabled: true,
      hooksJsonContainsManagedHooks: true,
      manifestValid: true,
      scriptInstalled: true,
      recommendedCommand: '/hook-status',
    });
  });

  it('repairs an explicit disabled hooks feature flag during install', async () => {
    const root = await createTmpDir();
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), '[features]\nhooks = false\n', 'utf8');
    const installer = createInstaller(codexHome, root);

    await expect(installer.status()).resolves.toMatchObject({ configFeatureEnabled: false, configured: false });
    await installer.install();

    await expect(readFile(join(codexHome, 'config.toml'), 'utf8')).resolves.toBe('[features]\nhooks = true\n');
    await expect(installer.status()).resolves.toMatchObject({ configFeatureEnabled: true });
  });

  it('preserves unrelated hooks while installing and uninstalling managed hooks', async () => {
    const root = await createTmpDir();
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, 'hooks.json'),
      JSON.stringify({ stop: [{ command: '/usr/local/bin/user-stop' }], custom: [{ command: 'custom' }] }),
      'utf8',
    );
    await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-5"\n', 'utf8');

    const installer = createInstaller(codexHome, root);
    await installer.install();
    await installer.uninstall();

    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
    const configToml = await readFile(join(codexHome, 'config.toml'), 'utf8');

    expect(hooks).toEqual({ stop: [{ command: '/usr/local/bin/user-stop' }], custom: [{ command: 'custom' }] });
    expect(configToml).toBe('model = "gpt-5"\n');
  });

  it('reports invalid hooks.json without deleting user files', async () => {
    const root = await createTmpDir();
    const codexHome = join(root, 'codex-home');
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'hooks.json'), '{not-json', 'utf8');

    const report = await createInstaller(codexHome, root).status();

    expect(report.hooksJsonValid).toBe(false);
    await expect(readFile(join(codexHome, 'hooks.json'), 'utf8')).resolves.toBe('{not-json');
  });

  it('uninstalls only files and entries recorded in the manifest', async () => {
    const root = await createTmpDir();
    const codexHome = join(root, 'codex-home');
    const installer = createInstaller(codexHome, root);
    await installer.install();
    const extraManagedDir = join(codexHome, '.code-bot/codex-hooks');
    await writeFile(join(extraManagedDir, 'user-note.txt'), 'keep me', 'utf8');

    const result = await installer.uninstall();

    expect(result).toMatchObject({ uninstalled: true });
    await expect(readFile(join(extraManagedDir, 'user-note.txt'), 'utf8')).resolves.toBe('keep me');
    await expect(pathExists(join(extraManagedDir, 'code_bot_hook.mjs'))).resolves.toBe(false);
    await expect(pathExists(join(extraManagedDir, 'manifest.json'))).resolves.toBe(false);
  });

  it('does not trust a tampered manifest to remove unrelated hook commands or files', async () => {
    const root = await createTmpDir();
    const codexHome = join(root, 'codex-home');
    const installer = createInstaller(codexHome, root);
    await installer.install();
    await writeFile(join(codexHome, 'user-hook.mjs'), 'keep me', 'utf8');
    await writeFile(
      join(codexHome, 'hooks.json'),
      JSON.stringify({ stop: [{ command: 'node user-hook.mjs' }, { command: 'custom' }] }),
      'utf8',
    );
    await writeFile(
      join(codexHome, '.code-bot/codex-hooks/manifest.json'),
      JSON.stringify({
        version: 1,
        installedAt: '2026-06-24T00:00:00.000Z',
        projectRoot: root,
        socketPath: join(root, '.code-bot/codex-hooks.sock'),
        managedFiles: ['user-hook.mjs'],
        managedHookEvents: ['stop'],
        managedCommand: 'node user-hook.mjs',
      }),
      'utf8',
    );

    const result = await installer.uninstall();

    expect(result.uninstalled).toBe(false);
    await expect(readFile(join(codexHome, 'user-hook.mjs'), 'utf8')).resolves.toBe('keep me');
    const hooks = JSON.parse(await readFile(join(codexHome, 'hooks.json'), 'utf8'));
    expect(hooks.stop).toEqual([{ command: 'node user-hook.mjs' }, { command: 'custom' }]);
  });
});
