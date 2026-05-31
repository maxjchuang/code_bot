import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { ApprovalManager } from '../../src/approvals/ApprovalManager.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('ApprovalManager', () => {
  it('creates and approves approval records', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new ApprovalManager(store, () => new Date('2026-05-31T10:00:00.000Z'));

    const approval = await manager.requestApproval({
      sessionId: 'sess_1',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      riskSummary: 'Stop running session',
      ttlMs: 60000,
    });

    expect(approval.status).toBe('pending');
    expect(manager.buildTextFallback(approval)).toContain(`/approve ${approval.id}`);

    const approved = await manager.resolve(approval.id, 'approved', 'ou_1');
    expect(approved.status).toBe('approved');
    expect(approved.resolvedBy).toBe('ou_1');

    const events = await readFile(join(root, '.code-bot/events/2026-05-31.jsonl'), 'utf8');
    expect(events).toContain('"type":"approval.created"');
    expect(events).toContain('"type":"approval.approved"');
  });

  it('serializes concurrent resolve calls and enforces single final state', async () => {
    const root = await createTmpDir();
    const store = new FileStateStore(root);
    const manager = new ApprovalManager(store, () => new Date('2026-05-31T10:00:00.000Z'));

    const approval = await manager.requestApproval({
      sessionId: 'sess_concurrent',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      riskSummary: 'Concurrent resolve test',
      ttlMs: 60000,
    });

    const settled = await Promise.allSettled([
      manager.resolve(approval.id, 'approved', 'ou_1'),
      manager.resolve(approval.id, 'rejected', 'ou_2'),
    ]);

    const fulfilled = settled.find((entry) => entry.status === 'fulfilled');
    const rejected = settled.find((entry) => entry.status === 'rejected');

    expect(fulfilled).toBeDefined();
    expect(rejected).toBeDefined();
    expect(fulfilled?.status).toBe('fulfilled');
    expect(rejected?.status).toBe('rejected');
    expect((rejected as PromiseRejectedResult).reason.message).toBe(`Approval is not pending: ${approval.id}`);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);

    const stored = await store.getApproval(approval.id);
    expect(stored?.status).toBe((fulfilled as PromiseFulfilledResult<{ status: 'approved' | 'rejected' }>).value.status);
  });

  it('expires approvals and blocks late resolution with event recording', async () => {
    let now = +new Date('2026-05-31T10:00:00.000Z');
    const clock = () => new Date(now);
    const root = await createTmpDir();
    const store = new FileStateStore(root, clock);
    const manager = new ApprovalManager(store, clock);

    const approval = await manager.requestApproval({
      sessionId: 'sess_expired',
      chatId: 'oc_1',
      requestedBy: 'ou_1',
      riskSummary: 'Expired approval test',
      ttlMs: 1000,
    });

    now += 2_000;

    await expect(manager.resolve(approval.id, 'approved', 'ou_1')).rejects.toThrow(`Approval expired: ${approval.id}`);
    const stored = await store.getApproval(approval.id);
    expect(stored?.status).toBe('expired');

    const events = await readFile(join(root, '.code-bot/events/2026-05-31.jsonl'), 'utf8');
    expect(events).toContain('"type":"approval.expired"');
  });
});
