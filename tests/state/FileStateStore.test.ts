import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';

describe('FileStateStore', () => {
  it('writes chat snapshots atomically and reads them back', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo' });

    await expect(store.getChat('oc_1')).resolves.toEqual({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
    });
  });

  it('appends audit events as json lines', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-05-31T10:00:00.000Z'));
    await store.appendEvent({ type: 'command.received', at: '2026-05-31T10:00:00.000Z', data: { command: '/status' } });

    const events = await readFile(join(root, '.code-bot/events/2026-05-31.jsonl'), 'utf8');

    expect(events.trim()).toBe(JSON.stringify({
      type: 'command.received',
      at: '2026-05-31T10:00:00.000Z',
      data: { command: '/status' },
    }));
  });

  it('stores and tails session logs', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_1', 'one\n');
    await store.appendSessionLog('session_1', 'two\nthree\n');

    await expect(store.tailSessionLog('session_1', 2)).resolves.toEqual(['two', 'three']);
  });

  it('rejects unsafe state ids and prevents path traversal', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);

    await expect(
      store.saveChat({ chatId: '../escape', chatType: 'group', currentProjectId: 'repo' }),
    ).rejects.toThrow('Invalid state id: ../escape');

    await expect(readFile(join(root, '.code-bot/state/escape.json'), 'utf8')).rejects.toThrow();
  });

  it('waits for queued session log writes before tailing', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);

    store.appendSessionLog('session_queue', 'one\n');
    store.appendSessionLog('session_queue', 'two\n');
    store.appendSessionLog('session_queue', 'three\n');

    await expect(store.tailSessionLog('session_queue', 3)).resolves.toEqual(['one', 'two', 'three']);
  });

  it('preserves blank lines when tailing session logs', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_blank', 'one\n\ntwo\n');

    await expect(store.tailSessionLog('session_blank', 3)).resolves.toEqual(['one', '', 'two']);
  });
});
