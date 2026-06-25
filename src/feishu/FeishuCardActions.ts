import type { ChatType } from '../domain/types.js';

export interface ModelSelectCardAction {
  kind: 'model_select';
  model: string;
  reasoning?: string;
}

export interface ProjectSelectCardAction {
  kind: 'project_select';
  projectId: string;
}

export interface ResumeSelectCardAction {
  kind: 'resume_select';
  sessionId: string;
}

export interface ApprovalDecisionCardAction {
  kind: 'approval_decision';
  approvalId: string;
  decision: 'approve' | 'reject';
}

export type FeishuCardActionPayload = ModelSelectCardAction | ProjectSelectCardAction | ResumeSelectCardAction | ApprovalDecisionCardAction;

export interface FeishuIncomingCardAction {
  chatId: string;
  chatType: ChatType;
  userId: string;
  messageId?: string;
  threadId?: string;
  action: FeishuCardActionPayload;
}

export function parseCardActionValue(
  value: unknown,
  formValue?: unknown,
): { chatId: string; chatType: ChatType; action: FeishuCardActionPayload } | undefined {
  if (!isObjectRecord(value) || typeof value.chatId !== 'string' || value.chatId.length === 0) {
    return undefined;
  }

  const chatType: ChatType = value.chatType === 'group' ? 'group' : 'private';
  const form = isObjectRecord(formValue) ? formValue : undefined;

  if (value.kind === 'model_select') {
    const model = readString(form?.model) ?? readString(value.model);
    if (!model) {
      return undefined;
    }
    const reasoning = readString(form?.reasoning) ?? readString(value.reasoning);
    return {
      chatId: value.chatId,
      chatType,
      action: reasoning ? { kind: 'model_select', model, reasoning } : { kind: 'model_select', model },
    };
  }

  if (value.kind === 'project_select') {
    const projectId = readString(form?.projectId) ?? readString(value.projectId);
    if (!projectId) {
      return undefined;
    }
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'project_select', projectId },
    };
  }

  if (value.kind === 'resume_select') {
    const sessionId = readString(form?.sessionId) ?? readString(value.sessionId);
    if (!sessionId) {
      return undefined;
    }
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'resume_select', sessionId },
    };
  }

  if (value.kind === 'approval_decision') {
    const approvalId = readString(form?.approvalId) ?? readString(value.approvalId);
    const decision = readApprovalDecision(form?.decision) ?? readApprovalDecision(value.decision);
    if (!approvalId || !decision) {
      return undefined;
    }
    return {
      chatId: value.chatId,
      chatType,
      action: { kind: 'approval_decision', approvalId, decision },
    };
  }

  return undefined;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readApprovalDecision(value: unknown): 'approve' | 'reject' | undefined {
  return value === 'approve' || value === 'reject' ? value : undefined;
}
