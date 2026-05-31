import { describe, expect, it } from 'vitest';
import { FileStateStore } from '../../src/state/FileStateStore.js';
import { ApprovalManager } from '../../src/approvals/ApprovalManager.js';
import { createTmpDir } from '../helpers/tmp.js';

describe('ApprovalManager', () => {
  it('creates and approves approval records', async () => {
    const store = new FileStateStore(await createTmpDir());
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
  });
});
