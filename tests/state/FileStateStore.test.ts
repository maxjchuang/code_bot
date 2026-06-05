import { mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTmpDir } from '../helpers/tmp.js';
import { FileStateStore } from '../../src/state/FileStateStore.js';

const fsMocks = vi.hoisted(() => ({
  open: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  fsMocks.open.mockImplementation(actual.open);
  fsMocks.stat.mockImplementation(actual.stat);
  return {
    ...actual,
    open: fsMocks.open,
    stat: fsMocks.stat,
  };
});

describe('FileStateStore', () => {
  beforeEach(() => {
    fsMocks.open.mockClear();
    fsMocks.stat.mockClear();
  });

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

  it('preserves model selections on chat records', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.saveChat({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          updatedAt: '2026-06-03T10:00:00.000Z',
        },
      },
    });

    await expect(store.getChat('oc_1')).resolves.toEqual({
      chatId: 'oc_1',
      chatType: 'group',
      currentProjectId: 'repo',
      modelSelectionsByProject: {
        repo: {
          model: 'gpt-5.5',
          reasoningEffort: 'high',
          updatedAt: '2026-06-03T10:00:00.000Z',
        },
      },
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

  it('tails bounded raw session log bytes for terminal replay', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);

    await store.appendSessionLog('session_bytes', 'old line\n');
    await store.appendSessionLog('session_bytes', 'new line\n');

    await expect(store.tailSessionLogBytes('session_bytes', 9)).resolves.toBe('new line\n');
  });

  it('returns empty replay bytes when session log is missing', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);

    await expect(store.tailSessionLogBytes('missing', 128)).resolves.toBe('');
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

  it('tails session logs from the end without returning older oversized content', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_large', `${'x'.repeat(2_000_000)}\n`);
    await store.appendSessionLog('session_large', 'last-one\nlast-two\n');

    await expect(store.tailSessionLog('session_large', 2)).resolves.toEqual(['last-one', 'last-two']);
  });

  it('caps a single oversized tailed log line', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_long_line', `${'x'.repeat(100_000)}\nlast\n`);

    const lines = await store.tailSessionLog('session_long_line', 2);

    expect(lines).toHaveLength(2);
    expect(lines[0]!.length).toBeLessThanOrEqual(16_384 + 32);
    expect(lines[0]).toContain('[truncated');
    expect(lines[1]).toBe('last');
  });

  it('returns one capped line when a single session log line exceeds the tail scan window', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_single_huge_line', 'x'.repeat(1_148_576));

    const lines = await store.tailSessionLog('session_single_huge_line', 1);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(16_384 + 32);
    expect(lines[0]).toContain('[truncated');
  });

  it('keeps the first complete line when the tail window starts after a newline', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const firstLine = 'first-in-window';
    const secondLine = 'second-in-window';
    const prefix = `${'x'.repeat(10)}\n`;
    const firstLines = `${firstLine}\n${secondLine}\n`;
    await store.appendSessionLog('session_boundary', prefix);
    await store.appendSessionLog('session_boundary', `${firstLines}${'z'.repeat(1_048_576 - 1 - firstLines.length)}`);

    const lines = await store.tailSessionLog('session_boundary', 3);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(firstLine);
    expect(lines[1]).toBe(secondLine);
    expect(lines[2]).toContain('[truncated');
  });

  it('returns no tailed session log lines for zero or negative line counts', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_no_lines', 'one\ntwo\n');

    await expect(store.tailSessionLog('session_no_lines', 0)).resolves.toEqual([]);
    await expect(store.tailSessionLog('session_no_lines', -1)).resolves.toEqual([]);
  });

  it('returns no tailed session log lines for non-finite line counts', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_non_finite_lines', 'one\ntwo\n');

    await expect(store.tailSessionLog('session_non_finite_lines', NaN)).resolves.toEqual([]);
    await expect(store.tailSessionLog('session_non_finite_lines', Infinity)).resolves.toEqual([]);
    await expect(store.tailSessionLog('session_non_finite_lines', -Infinity)).resolves.toEqual([]);
  });

  it('reads a bounded tail window with a short-read loop and closes the file', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const read = vi.fn()
      .mockResolvedValueOnce({ bytesRead: 400_000, buffer: Buffer.alloc(0) })
      .mockResolvedValueOnce({ bytesRead: 400_000, buffer: Buffer.alloc(0) })
      .mockResolvedValueOnce({ bytesRead: 248_576, buffer: Buffer.alloc(0) });
    const close = vi.fn().mockResolvedValue(undefined);
    fsMocks.stat.mockResolvedValueOnce({ size: 2_000_000 });
    fsMocks.open.mockResolvedValueOnce({ read, close });

    const lines = await store.tailSessionLog('session_short_reads', 1);

    expect(lines).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.map((call) => call[2])).toEqual([1_048_576, 648_576, 248_576]);
    expect(read.mock.calls.map((call) => call[3])).toEqual([951_424, 1_351_424, 1_751_424]);
    const bytesRead = await Promise.all(read.mock.results.map(async (result) => (await result.value).bytesRead));
    expect(bytesRead.reduce((total, count) => total + count, 0)).toBe(1_048_576);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fsMocks.open).toHaveBeenCalledWith(expect.stringContaining('session_short_reads.log'), 'r');
  });

  it('closes the session log file when a tail read fails', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const readError = new Error('read failed');
    const read = vi.fn().mockRejectedValue(readError);
    const close = vi.fn().mockResolvedValue(undefined);
    fsMocks.stat.mockResolvedValueOnce({ size: 32 });
    fsMocks.open.mockResolvedValueOnce({ read, close });

    await expect(store.tailSessionLog('session_read_error', 1)).rejects.toThrow(readError);

    expect(read).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('caps session log lines read from an old byte offset', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_offset', `${'x'.repeat(2_000_000)}\ncurrent\n`);

    const lines = await store.sessionLogLinesFrom('session_offset', 0);

    expect(lines.at(-1)).toBe('current');
    expect(lines.every((line) => line.length <= 16_384 + 32)).toBe(true);
  });

  it('returns one capped line when a single session log line from an old offset exceeds the scan window', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    await store.appendSessionLog('session_offset_single_huge_line', 'x'.repeat(1_148_576));

    const lines = await store.sessionLogLinesFrom('session_offset_single_huge_line', 0);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.length).toBeLessThanOrEqual(16_384 + 32);
    expect(lines[0]).toContain('[truncated');
  });

  it('keeps the first complete line when the old-offset scan window starts after a newline', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const firstLine = 'first-from-window';
    const secondLine = 'second-from-window';
    const prefix = `${'x'.repeat(10)}\n`;
    const firstLines = `${firstLine}\n${secondLine}\n`;
    await store.appendSessionLog('session_offset_boundary', prefix);
    await store.appendSessionLog('session_offset_boundary', `${firstLines}${'z'.repeat(1_048_576 - 1 - firstLines.length)}`);

    const lines = await store.sessionLogLinesFrom('session_offset_boundary', 0);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(firstLine);
    expect(lines[1]).toBe(secondLine);
    expect(lines[2]).toContain('[truncated');
  });

  it('reads old-offset session log lines with a short-read loop and closes the file', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const read = vi.fn()
      .mockResolvedValueOnce({ bytesRead: 400_000, buffer: Buffer.alloc(0) })
      .mockResolvedValueOnce({ bytesRead: 400_000, buffer: Buffer.alloc(0) })
      .mockResolvedValueOnce({ bytesRead: 248_576, buffer: Buffer.alloc(0) });
    const close = vi.fn().mockResolvedValue(undefined);
    fsMocks.stat.mockResolvedValueOnce({ size: 2_000_000 });
    fsMocks.open.mockResolvedValueOnce({ read, close });

    const lines = await store.sessionLogLinesFrom('session_offset_short_reads', 0);

    expect(lines).toHaveLength(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls.map((call) => call[2])).toEqual([1_048_576, 648_576, 248_576]);
    expect(read.mock.calls.map((call) => call[3])).toEqual([951_424, 1_351_424, 1_751_424]);
    const bytesRead = await Promise.all(read.mock.results.map(async (result) => (await result.value).bytesRead));
    expect(bytesRead.reduce((total, count) => total + count, 0)).toBe(1_048_576);
    expect(close).toHaveBeenCalledTimes(1);
    expect(fsMocks.open).toHaveBeenCalledWith(expect.stringContaining('session_offset_short_reads.log'), 'r');
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
