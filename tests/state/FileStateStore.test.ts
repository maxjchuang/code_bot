import { mkdir, readFile, readdir } from 'node:fs/promises';
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

  it('appends error logs as json lines', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-05-31T10:00:00.000Z'));
    await store.appendErrorLog({
      at: '2026-05-31T10:00:00.000Z',
      source: 'feishu.gateway',
      message: 'Request failed with status code 400',
      data: { responseStatus: 400, code: 230028 },
    });

    const errors = await readFile(join(root, '.code-bot/logs/errors/2026-05-31.jsonl'), 'utf8');

    expect(errors.trim()).toBe(JSON.stringify({
      at: '2026-05-31T10:00:00.000Z',
      source: 'feishu.gateway',
      message: 'Request failed with status code 400',
      data: { responseStatus: 400, code: 230028 },
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

  it('returns empty pending approvals when approvals directory is missing', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);

    await expect(store.listPendingApprovalsByChat('oc_1')).resolves.toEqual([]);
  });

  it('lists only pending approvals for the requested chat', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.saveApproval({
      id: 'ap_pending',
      sessionId: 'session_1',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      status: 'pending',
      riskSummary: 'pending',
      createdAt: '2026-05-31T10:00:00.000Z',
      expiresAt: '2026-05-31T11:00:00.000Z',
    });
    await store.saveApproval({
      id: 'ap_other_chat',
      sessionId: 'session_1',
      chatId: 'oc_2',
      requestedBy: 'ou_1',
      status: 'pending',
      riskSummary: 'pending',
      createdAt: '2026-05-31T10:00:00.000Z',
      expiresAt: '2026-05-31T11:00:00.000Z',
    });
    await store.saveApproval({
      id: 'ap_approved',
      sessionId: 'session_1',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      status: 'approved',
      riskSummary: 'approved',
      createdAt: '2026-05-31T10:00:00.000Z',
      expiresAt: '2026-05-31T11:00:00.000Z',
      resolvedBy: 'ou_1',
      resolvedAt: '2026-05-31T10:01:00.000Z',
    });

    await expect(store.listPendingApprovalsByChat('oc_1')).resolves.toMatchObject([{ id: 'ap_pending' }]);
  });

  it('lists recent sessions for a chat', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.saveSession({
      id: 'sess_old',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-05-31T10:00:00.000Z',
      updatedAt: '2026-05-31T10:01:00.000Z',
      logPath: store.sessionLogPath('sess_old'),
    });
    await store.saveSession({
      id: 'sess_new',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-05-31T10:02:00.000Z',
      updatedAt: '2026-05-31T10:03:00.000Z',
      logPath: store.sessionLogPath('sess_new'),
    });
    await store.saveSession({
      id: 'sess_other_chat',
      chatId: 'oc_2',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-05-31T10:04:00.000Z',
      updatedAt: '2026-05-31T10:05:00.000Z',
      logPath: store.sessionLogPath('sess_other_chat'),
    });

    await expect(store.listSessionsByChat('oc_1')).resolves.toMatchObject([{ id: 'sess_new' }, { id: 'sess_old' }]);
  });

  it('lists all persisted sessions and chats', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.saveChat({ chatId: 'oc_1', chatType: 'group', currentProjectId: 'repo', currentSessionId: 'sess_1' });
    await store.saveChat({ chatId: 'oc_2', chatType: 'group', currentProjectId: 'repo2' });
    await store.saveSession({
      id: 'sess_1',
      chatId: 'oc_1',
      projectId: 'repo',
      status: 'running',
      createdBy: 'ou_1',
      createdAt: '2026-05-31T10:00:00.000Z',
      updatedAt: '2026-05-31T10:01:00.000Z',
      logPath: store.sessionLogPath('sess_1'),
    });
    await store.saveSession({
      id: 'sess_2',
      chatId: 'oc_2',
      projectId: 'repo2',
      status: 'exited',
      createdBy: 'ou_1',
      createdAt: '2026-05-31T10:02:00.000Z',
      updatedAt: '2026-05-31T10:03:00.000Z',
      logPath: store.sessionLogPath('sess_2'),
    });

    await expect(store.listChats()).resolves.toMatchObject([{ chatId: 'oc_1' }, { chatId: 'oc_2' }]);
    await expect(store.listSessions()).resolves.toMatchObject([{ id: 'sess_2' }, { id: 'sess_1' }]);
  });

  it('claims a first inbound message id and persists the receipt', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-03T10:00:00.000Z'));
    const text = 'a'.repeat(201);
    const textPreview = text.length <= 200 ? text : `${text.slice(0, 197)}...`;

    const result = await store.claimInboundMessage({
      messageId: 'om_123',
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text,
    });

    expect(textPreview).toHaveLength(200);
    expect(textPreview.endsWith('...')).toBe(true);
    expect(result).toEqual({
      claimed: true,
      receipt: {
        messageId: 'om_123',
        chatId: 'oc_1',
        chatType: 'group',
        userId: 'ou_1',
        textPreview,
        firstReceivedAt: '2026-06-03T10:00:00.000Z',
        duplicateCount: 0,
        status: 'claimed',
      },
    });
    if (!result.claimed || !('receipt' in result)) {
      throw new Error('Expected first claim to include a receipt');
    }
    const receipt = JSON.parse(await readFile(join(root, '.code-bot/state/inbound-messages/om_123.json'), 'utf8'));
    expect(receipt).toEqual(result.receipt);
  });

  it('drops duplicate inbound message ids and increments duplicate count', async () => {
    const root = await createTmpDir();
    let now = new Date('2026-06-03T10:00:00.000Z');
    const store = new FileStateStore(root, () => now);

    await store.claimInboundMessage({
      messageId: 'om_123',
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'hello codex',
    });
    now = new Date('2026-06-03T10:00:20.000Z');

    const duplicate = await store.claimInboundMessage({
      messageId: 'om_123',
      chatId: 'oc_1',
      chatType: 'group',
      userId: 'ou_1',
      text: 'hello codex',
    });

    expect(duplicate).toMatchObject({
      claimed: false,
      receipt: {
        messageId: 'om_123',
        duplicateCount: 1,
        firstReceivedAt: '2026-06-03T10:00:00.000Z',
        lastDuplicateAt: '2026-06-03T10:00:20.000Z',
      },
    });
    const receipt = JSON.parse(await readFile(join(root, '.code-bot/state/inbound-messages/om_123.json'), 'utf8'));
    expect(receipt.duplicateCount).toBe(1);
    expect(receipt.lastDuplicateAt).toBe('2026-06-03T10:00:20.000Z');
  });

  it('treats missing inbound message id as claimed without writing a receipt', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);

    await expect(
      store.claimInboundMessage({
        chatId: 'oc_1',
        chatType: 'group',
        userId: 'ou_1',
        text: 'hello codex',
      }),
    ).resolves.toEqual({ claimed: true, reason: 'missing_message_id' });

    let receipts: string[] = [];
    try {
      receipts = await readdir(join(root, '.code-bot/state/inbound-messages'));
    } catch (error) {
      expect(error).toMatchObject({ code: 'ENOENT' });
    }
    expect(receipts).toEqual([]);
  });

  it('serializes concurrent inbound message claims for the same id', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root, () => new Date('2026-06-03T10:00:00.000Z'));

    const results = await Promise.all([
      store.claimInboundMessage({ messageId: 'om_123', chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'hello codex' }),
      store.claimInboundMessage({ messageId: 'om_123', chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'hello codex' }),
    ]);

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    expect(results.filter((result) => !result.claimed)).toHaveLength(1);
    const receipt = JSON.parse(await readFile(join(root, '.code-bot/state/inbound-messages/om_123.json'), 'utf8'));
    expect(receipt.duplicateCount).toBe(1);
  });

  it('rejects unsafe inbound message ids and prevents path traversal', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);

    await expect(
      store.claimInboundMessage({ messageId: '../escape', chatId: 'oc_1', chatType: 'group', userId: 'ou_1', text: 'hello codex' }),
    ).rejects.toThrow('Invalid state id: ../escape');

    await mkdir(join(root, '.code-bot/state/inbound-messages'), { recursive: true });
    await expect(readFile(join(root, '.code-bot/state/escape.json'), 'utf8')).rejects.toThrow();
  });
});
