import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { loadConfig } from '../../src/config/loadConfig.js';

describe('loadConfig', () => {
  it('loads a valid bot config', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.code-bot'), { recursive: true });
    await writeFile(
      join(root, '.code-bot/config.json'),
      JSON.stringify({
        feishu: { appId: 'cli_xxx', appSecret: 'secret' },
        allowedUsers: ['ou_user_1'],
        allowedChatIds: ['oc_group_1'],
        projects: [
          { id: 'repo', name: 'Repo', path: root, codexArgs: ['--ask-for-approval', 'on-request'] }
        ],
        output: { directMaxChars: 1800, chunkSize: 1500 },
        codex: { command: 'codex', defaultArgs: [] }
      }),
      'utf8',
    );

    const config = await loadConfig(root);

    expect(config.projects[0].id).toBe('repo');
    expect(config.output.directMaxChars).toBe(1800);
  });

  it('resolves relative project paths from projectRoot', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.code-bot'), { recursive: true });
    await writeFile(
      join(root, '.code-bot/config.json'),
      JSON.stringify({
        feishu: { appId: 'cli_xxx', appSecret: 'secret' },
        allowedUsers: ['ou_user_1'],
        allowedChatIds: ['oc_group_1'],
        projects: [
          { id: 'repo', name: 'Repo', path: 'repo', codexArgs: [] }
        ],
        output: { directMaxChars: 1800, chunkSize: 1500 },
        codex: { command: 'codex', defaultArgs: [] }
      }),
      'utf8',
    );

    const config = await loadConfig(root);

    expect(config.projects[0].path).toBe(join(root, 'repo'));
  });

  it('rejects duplicate project ids', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.code-bot'), { recursive: true });
    await writeFile(
      join(root, '.code-bot/config.json'),
      JSON.stringify({
        feishu: { appId: 'cli_xxx', appSecret: 'secret' },
        allowedUsers: ['ou_user_1'],
        allowedChatIds: [],
        projects: [
          { id: 'repo', name: 'Repo A', path: root },
          { id: 'repo', name: 'Repo B', path: root }
        ],
        output: { directMaxChars: 1800, chunkSize: 1500 },
        codex: { command: 'codex', defaultArgs: [] }
      }),
      'utf8',
    );

    await expect(loadConfig(root)).rejects.toThrow('Duplicate project id: repo');
  });

  it('rejects malformed top-level null config', async () => {
    const root = await createTmpDir();
    await mkdir(join(root, '.code-bot'), { recursive: true });
    await writeFile(join(root, '.code-bot/config.json'), 'null', 'utf8');

    await expect(loadConfig(root)).rejects.toThrow('Invalid config structure');
  });
});
