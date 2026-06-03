import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { CodexSessionRegistry } from '../../src/codex/CodexSessionRegistry.js';

describe('CodexSessionRegistry', () => {
  it('reads session index entries', async () => {
    const root = await createTmpDir();
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'session_index.jsonl'),
      '{"id":"019e7f20-a667-7632-a808-c9595d77116e","thread_name":"resume work","updated_at":"2026-06-01T10:00:00.000Z"}\n',
      'utf8',
    );

    const registry = new CodexSessionRegistry(root);

    await expect(registry.listIndexEntries()).resolves.toEqual([
      {
        id: '019e7f20-a667-7632-a808-c9595d77116e',
        threadName: 'resume work',
        updatedAt: '2026-06-01T10:00:00.000Z',
      },
    ]);
  });

  it('skips malformed session index lines', async () => {
    const root = await createTmpDir();
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, 'session_index.jsonl'),
      [
        '{"id":"019e7f20-a667-7632-a808-c9595d77116e","thread_name":"resume work","updated_at":"2026-06-01T10:00:00.000Z"}',
        '{not json',
        '{"id":"019e7f21-a667-7632-a808-c9595d77116e","thread_name":"next work","updated_at":"2026-06-01T10:01:00.000Z"}',
        '',
      ].join('\n'),
      'utf8',
    );

    const registry = new CodexSessionRegistry(root);

    await expect(registry.listIndexEntries()).resolves.toEqual([
      {
        id: '019e7f20-a667-7632-a808-c9595d77116e',
        threadName: 'resume work',
        updatedAt: '2026-06-01T10:00:00.000Z',
      },
      {
        id: '019e7f21-a667-7632-a808-c9595d77116e',
        threadName: 'next work',
        updatedAt: '2026-06-01T10:01:00.000Z',
      },
    ]);
  });

  it('discovers a unique session by project path and start time', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(root, 'session_index.jsonl'), '', 'utf8');
    const sessionFile = join(sessionDir, 'rollout-2026-06-01T10-00-02-019e7f20-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      sessionFile,
      '{"type":"session_meta","payload":{"cwd":"/tmp/project"}}\n',
      'utf8',
    );
    await utimes(sessionFile, new Date('2026-06-01T10:00:02.000Z'), new Date('2026-06-01T10:00:02.000Z'));

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: '/tmp/project',
        startedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' });
  });

  it('matches the same project when config and session cwd use different absolute path aliases', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    const projectDir = join(root, 'project');
    const aliasedProjectDir = join(root, 'project-alias');
    await mkdir(sessionDir, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(root, 'session_index.jsonl'), '', 'utf8');
    await expect(import('node:fs/promises').then(({ symlink }) => symlink(projectDir, aliasedProjectDir))).resolves.toBeUndefined();

    const sessionFile = join(sessionDir, 'rollout-2026-06-01T10-00-02-019e7f20-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      sessionFile,
      `{"type":"session_meta","payload":{"cwd":"${projectDir}"}}\n`,
      'utf8',
    );
    await utimes(sessionFile, new Date('2026-06-01T10:00:02.000Z'), new Date('2026-06-01T10:00:02.000Z'));

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: aliasedProjectDir,
        startedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' });
  });

  it('does not match project path substrings', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, 'rollout-2026-06-01T10-00-02-019e7f20-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      sessionFile,
      '{"type":"session_meta","payload":{"cwd":"/tmp/project-other"}}\n',
      'utf8',
    );
    await utimes(sessionFile, new Date('2026-06-01T10:00:02.000Z'), new Date('2026-06-01T10:00:02.000Z'));

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: '/tmp/project',
        startedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('does not match prompt text containing the project path without session meta cwd', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, 'rollout-2026-06-01T10-00-02-019e7f20-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      sessionFile,
      '{"type":"user_message","payload":{"text":"please inspect /tmp/project"}}\n',
      'utf8',
    );
    await utimes(sessionFile, new Date('2026-06-01T10:00:02.000Z'), new Date('2026-06-01T10:00:02.000Z'));

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: '/tmp/project',
        startedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns not-found for invalid start time', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, 'rollout-2026-06-01T10-00-02-019e7f20-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      sessionFile,
      '{"type":"session_meta","payload":{"cwd":"/tmp/project"}}\n',
      'utf8',
    );

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: '/tmp/project',
        startedAt: 'not a date',
      }),
    ).resolves.toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns ambiguous when multiple candidates match', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(join(root, 'session_index.jsonl'), '', 'utf8');
    const firstFile = join(sessionDir, 'rollout-2026-06-01T10-00-02-019e7f20-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      firstFile,
      '{"type":"session_meta","payload":{"cwd":"/tmp/project"}}\n',
      'utf8',
    );
    await utimes(firstFile, new Date('2026-06-01T10:00:02.000Z'), new Date('2026-06-01T10:00:02.000Z'));
    const secondFile = join(sessionDir, 'rollout-2026-06-01T10-00-03-019e7f21-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      secondFile,
      '{"type":"session_meta","payload":{"cwd":"/tmp/project"}}\n',
      'utf8',
    );
    await utimes(secondFile, new Date('2026-06-01T10:00:03.000Z'), new Date('2026-06-01T10:00:03.000Z'));

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: '/tmp/project',
        startedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('ignores older sessions even when their files were updated after start time', async () => {
    const root = await createTmpDir();
    const sessionDir = join(root, 'sessions/2026/06/01');
    await mkdir(sessionDir, { recursive: true });
    const oldFile = join(sessionDir, 'rollout-2026-06-01T09-00-00-019e7f19-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      oldFile,
      '{"timestamp":"2026-06-01T09:00:00.000Z","type":"session_meta","payload":{"timestamp":"2026-06-01T09:00:00.000Z","cwd":"/tmp/project"}}\n',
      'utf8',
    );
    await utimes(oldFile, new Date('2026-06-01T10:05:00.000Z'), new Date('2026-06-01T10:05:00.000Z'));
    const newFile = join(sessionDir, 'rollout-2026-06-01T10-00-12-019e7f20-a667-7632-a808-c9595d77116e.jsonl');
    await writeFile(
      newFile,
      '{"timestamp":"2026-06-01T10:00:12.000Z","type":"session_meta","payload":{"timestamp":"2026-06-01T10:00:01.000Z","cwd":"/tmp/project"}}\n',
      'utf8',
    );
    await utimes(newFile, new Date('2026-06-01T10:00:12.000Z'), new Date('2026-06-01T10:00:12.000Z'));

    const registry = new CodexSessionRegistry(root);

    await expect(
      registry.discoverForProject({
        projectPath: '/tmp/project',
        startedAt: '2026-06-01T10:00:00.000Z',
      }),
    ).resolves.toEqual({ ok: true, codexSessionId: '019e7f20-a667-7632-a808-c9595d77116e' });
  });
});
