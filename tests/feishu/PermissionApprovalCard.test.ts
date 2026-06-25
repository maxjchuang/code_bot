import { describe, expect, it } from 'vitest';
import type { ApprovalRecord } from '../../src/domain/types.js';
import { renderPermissionApprovalCard } from '../../src/feishu/PermissionApprovalCard.js';

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'appr_permission_1',
    sessionId: 'sess_1',
    chatId: 'oc_1',
    requestedBy: 'hook',
    status: 'pending',
    riskSummary: 'Run shell command',
    createdAt: '2026-06-24T10:00:00.000Z',
    expiresAt: '2026-06-24T10:05:00.000Z',
    toolName: 'shell',
    toolInput: { command: 'npm install', cwd: '/repo' },
    hookRequestId: 'hook_req_1',
    projectId: 'repo',
    ...overrides,
  };
}

describe('renderPermissionApprovalCard', () => {
  it('renders permission approval card with allow and deny actions', () => {
    const rendered = renderPermissionApprovalCard({
      chatId: 'oc_1',
      chatType: 'group',
      approval: approval(),
      timeZone: 'Asia/Shanghai',
    });

    expect(rendered.fallback).toEqual({
      kind: 'text',
      text: [
        'Approval required: shell',
        'Project: repo',
        'Session: sess_1',
        'Expires: 2026-06-24T10:05:00.000Z',
        'Approve: /approve appr_permission_1',
        'Reject: /reject appr_permission_1',
      ].join('\n'),
    });
    expect(rendered.preferred.kind).toBe('card');
    const cardJson = JSON.stringify(rendered.preferred);
    expect(cardJson).toContain('Allow');
    expect(cardJson).toContain('Deny');
    expect(cardJson).toContain('"kind":"approval_decision"');
    expect(cardJson).toContain('"approvalId":"appr_permission_1"');
    expect(cardJson).toContain('"decision":"approve"');
    expect(cardJson).toContain('"decision":"reject"');
  });

  it('truncates large tool input fields', () => {
    const rendered = renderPermissionApprovalCard({
      chatId: 'oc_1',
      chatType: 'group',
      approval: approval({ toolInput: { command: 'x'.repeat(2000) } }),
      timeZone: 'Asia/Shanghai',
    });

    const cardJson = JSON.stringify(rendered.preferred);
    expect(cardJson).toContain('truncated');
    expect(cardJson).not.toContain('x'.repeat(1500));
  });
});
