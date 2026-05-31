import type { ApprovalRecord } from '../domain/types.js';
import { FileStateStore } from '../state/FileStateStore.js';

type Clock = () => Date;

export interface ApprovalRequest {
  sessionId: string;
  chatId: string;
  requestedBy: string;
  riskSummary: string;
  ttlMs: number;
}

export class ApprovalManager {
  private readonly resolveQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: FileStateStore, private readonly clock: Clock = () => new Date()) {}

  async resolve(approvalId: string, status: 'approved' | 'rejected', userId: string): Promise<ApprovalRecord> {
    const run = async () => {
      const approval = await this.store.getApproval(approvalId);
      if (!approval) {
        throw new Error(`Approval not found: ${approvalId}`);
      }

      if (approval.status !== 'pending') {
        throw new Error(`Approval is not pending: ${approvalId}`);
      }

      const now = this.clock();
      if (now.getTime() > new Date(approval.expiresAt).getTime()) {
        const expired: ApprovalRecord = {
          ...approval,
          status: 'expired',
        };
        await this.store.saveApproval(expired);
        await this.store.appendEvent({ type: 'approval.expired', at: now.toISOString(), data: { approvalId, userId } });
        throw new Error(`Approval expired: ${approvalId}`);
      }

      const resolvedAt = this.clock().toISOString();
      const resolved: ApprovalRecord = {
        ...approval,
        status,
        resolvedBy: userId,
        resolvedAt,
      };
      await this.store.saveApproval(resolved);
      await this.store.appendEvent({ type: `approval.${status}`, at: resolvedAt, data: { approvalId, userId } });
      return resolved;
    };

    return this.withResolveLock(approvalId, run);
  }

  private async withResolveLock<T>(approvalId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.resolveQueues.get(approvalId) ?? Promise.resolve();
    const current = previous.then(() => action());
    const chain = current.catch(() => undefined);
    this.resolveQueues.set(approvalId, chain);

    try {
      return await current;
    } finally {
      if (this.resolveQueues.get(approvalId) === chain) {
        this.resolveQueues.delete(approvalId);
      }
    }
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalRecord> {
    const now = this.clock();
    const approval: ApprovalRecord = {
      id: `appr_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: request.sessionId,
      chatId: request.chatId,
      requestedBy: request.requestedBy,
      status: 'pending',
      riskSummary: request.riskSummary,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + request.ttlMs).toISOString(),
    };
    await this.store.saveApproval(approval);
    await this.store.appendEvent({ type: 'approval.created', at: approval.createdAt, data: { approvalId: approval.id, sessionId: approval.sessionId } });
    return approval;
  }

  buildTextFallback(approval: ApprovalRecord): string {
    return [
      `Approval required: ${approval.riskSummary}`,
      `Session: ${approval.sessionId}`,
      `Expires: ${approval.expiresAt}`,
      `Approve: /approve ${approval.id}`,
      `Reject: /reject ${approval.id}`,
    ].join('\n');
  }
}
