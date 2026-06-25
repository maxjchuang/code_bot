import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { loadConfig } from '../../src/config/loadConfig.js';

async function writeConfig(root: string, config: unknown): Promise<void> {
  await mkdir(join(root, '.code-bot'), { recursive: true });
  await writeFile(join(root, '.code-bot/config.json'), JSON.stringify(config), 'utf8');
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feishu: { appId: 'cli', appSecret: 'secret' },
    allowedUsers: ['ou_1'],
    allowedChatIds: ['oc_1'],
    restrictUsers: true,
    restrictChatIds: true,
    projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
    output: { directMaxChars: 1800, chunkSize: 1500 },
    codex: { command: 'codex', defaultArgs: [] },
    ...overrides,
  };
}

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

  it('defaults notification config when omitted', async () => {
    const root = await createTmpDir();
    await writeConfig(root, {
      feishu: { appId: 'cli', appSecret: 'secret' },
      allowedUsers: ['ou_1'],
      allowedChatIds: ['oc_1'],
      projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
      output: { directMaxChars: 1800, chunkSize: 1500 },
      codex: { command: 'codex', defaultArgs: [] },
    });

    await expect(loadConfig(root)).resolves.toMatchObject({
      ui: {
        verbosity: 'normal',
        currentRenderMode: 'markdown',
        timeZone: 'Asia/Shanghai',
      },
      notifications: {
        enabled: true,
        idleMs: 3000,
        maxFinalChars: 8000,
        failureTailChars: 2000,
      },
    });
  });

  it('defaults upgrade config to disabled with safe defaults', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      upgrade: {
        enabled: false,
        adminUsers: [],
        pm2ProcessName: 'code-bot',
        remote: 'origin',
        branch: 'main',
      },
    });
  });

  it('defaults codex hook config to disabled with safe defaults', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      codexHooks: {
        enabled: false,
        autoRepair: false,
        socketPath: '.code-bot/codex-hooks.sock',
        permissionTimeoutMs: 300000,
        adminUsers: [],
      },
    });
  });

  it('loads explicit codex hook config', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      codexHooks: {
        enabled: true,
        autoRepair: true,
        socketPath: '/tmp/code-bot-hooks.sock',
        permissionTimeoutMs: 1000,
        adminUsers: ['ou_admin_1'],
      },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      codexHooks: {
        enabled: true,
        autoRepair: true,
        socketPath: '/tmp/code-bot-hooks.sock',
        permissionTimeoutMs: 1000,
        adminUsers: ['ou_admin_1'],
      },
    });
  });

  it('rejects malformed codex hook config values', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ codexHooks: { permissionTimeoutMs: 0 } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: codexHooks.permissionTimeoutMs');
  });

  it('loads explicit upgrade config', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({
      upgrade: {
        enabled: true,
        adminUsers: ['ou_admin_1'],
        pm2ProcessName: 'code-bot-prod',
        remote: 'upstream',
        branch: 'develop',
      },
    }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      upgrade: {
        enabled: true,
        adminUsers: ['ou_admin_1'],
        pm2ProcessName: 'code-bot-prod',
        remote: 'upstream',
        branch: 'develop',
      },
    });
  });

  it('rejects enabled upgrade config without admin users', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ upgrade: { enabled: true } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: upgrade.adminUsers');
  });

  it('rejects malformed upgrade container', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ upgrade: true }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: upgrade');
  });

  it('defaults terminal snapshot config when omitted', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      output: {
        terminalSnapshot: {
          cols: 120,
          rows: 40,
          scrollback: 200,
          replayMaxBytes: 262144,
          cardMaxRows: 40,
          cardMaxLineChars: 160,
          maxStyledSegmentsPerLine: 8,
        },
      },
    });
  });

  it('loads terminal snapshot config overrides', async () => {
    const root = await createTmpDir();
    await writeConfig(
      root,
      validConfig({
        output: {
          directMaxChars: 1800,
          chunkSize: 1500,
          terminalSnapshot: {
            cols: 100,
            rows: 30,
            scrollback: 50,
            replayMaxBytes: 4096,
            cardMaxRows: 20,
            cardMaxLineChars: 80,
            maxStyledSegmentsPerLine: 4,
          },
        },
      }),
    );

    await expect(loadConfig(root)).resolves.toMatchObject({
      output: {
        terminalSnapshot: {
          cols: 100,
          rows: 30,
          scrollback: 50,
          replayMaxBytes: 4096,
          cardMaxRows: 20,
          cardMaxLineChars: 80,
          maxStyledSegmentsPerLine: 4,
        },
      },
    });
  });

  it('rejects invalid terminal snapshot config values', async () => {
    const root = await createTmpDir();
    await writeConfig(
      root,
      validConfig({
        output: {
          directMaxChars: 1800,
          chunkSize: 1500,
          terminalSnapshot: { cols: 0 },
        },
      }),
    );

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: output.terminalSnapshot.cols');
  });

  it('defaults user and chat restrictions to disabled when omitted', async () => {
    const root = await createTmpDir();
    await writeConfig(root, {
      feishu: { appId: 'cli', appSecret: 'secret' },
      projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
      output: { directMaxChars: 1800, chunkSize: 1500 },
      codex: { command: 'codex', defaultArgs: [] },
    });

    await expect(loadConfig(root)).resolves.toMatchObject({
      restrictUsers: false,
      restrictChatIds: false,
      allowedUsers: [],
      allowedChatIds: [],
    });
  });

  it('loads explicit user and chat restriction switches', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ restrictUsers: true, restrictChatIds: false }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      restrictUsers: true,
      restrictChatIds: false,
      allowedUsers: ['ou_1'],
      allowedChatIds: ['oc_1'],
    });
  });

  it('loads custom notification config', async () => {
    const root = await createTmpDir();
    await writeConfig(root, {
      feishu: { appId: 'cli', appSecret: 'secret' },
      allowedUsers: ['ou_1'],
      allowedChatIds: ['oc_1'],
      projects: [{ id: 'repo', name: 'Repo', path: '.', codexArgs: [] }],
      output: { directMaxChars: 1800, chunkSize: 1500 },
      codex: { command: 'codex', defaultArgs: [] },
      logLevel: 'debug',
      notifications: { enabled: false, idleMs: 50, maxFinalChars: 1000, failureTailChars: 500 },
      ui: { verbosity: 'debug', currentRenderMode: 'code', timeZone: 'UTC' },
    });

    await expect(loadConfig(root)).resolves.toMatchObject({
      logLevel: 'debug',
      ui: { verbosity: 'debug', currentRenderMode: 'code', timeZone: 'UTC' },
      notifications: { enabled: false, idleMs: 50, maxFinalChars: 1000, failureTailChars: 500 },
    });
  });

  it('defaults log level to info when omitted', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig());

    await expect(loadConfig(root)).resolves.toMatchObject({
      logLevel: 'info',
    });
  });

  it('loads log level from config', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ logLevel: 'error' }));

    await expect(loadConfig(root)).resolves.toMatchObject({
      logLevel: 'error',
    });
  });

  it('rejects malformed notification config container', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ notifications: true }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: notifications');
  });

  it('rejects malformed notification enabled field', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ notifications: { enabled: 'yes' } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: notifications.enabled');
  });

  it('rejects malformed notification idleMs field', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ notifications: { idleMs: 0 } }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: notifications.idleMs');
  });

  it('rejects malformed restrictUsers field', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ restrictUsers: 'yes' }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: restrictUsers');
  });

  it('rejects malformed logLevel field', async () => {
    const root = await createTmpDir();
    await writeConfig(root, validConfig({ logLevel: 'verbose' }));

    await expect(loadConfig(root)).rejects.toThrow('Invalid config field: logLevel');
  });
});
