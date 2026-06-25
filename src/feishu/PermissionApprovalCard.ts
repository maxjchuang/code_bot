import type { ApprovalRecord, ChatType } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export interface RenderPermissionApprovalCardInput {
  chatId: string;
  chatType: ChatType;
  approval: ApprovalRecord;
  timeZone: string;
}

const TOOL_INPUT_MAX_CHARS = 800;

export function renderPermissionApprovalCard(
  input: RenderPermissionApprovalCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const fallbackText = buildPermissionFallback(input.approval);
  const payload = {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: 'Permission Approval',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: [
            `**Tool**: \`${input.approval.toolName ?? input.approval.riskSummary}\``,
            input.approval.projectId ? `**Project**: \`${input.approval.projectId}\`` : undefined,
            `**Session**: \`${input.approval.sessionId}\``,
            `**Expires**: ${input.approval.expiresAt}`,
          ]
            .filter((line): line is string => Boolean(line))
            .join('\n'),
        },
        {
          tag: 'markdown',
          content: `**Input**\n\`\`\`json\n${formatToolInput(input.approval.toolInput)}\n\`\`\``,
        },
        {
          tag: 'hr',
        },
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: 'Allow',
          },
          type: 'primary',
          behaviors: [
            {
              type: 'callback',
              value: {
                kind: 'approval_decision',
                chatId: input.chatId,
                chatType: input.chatType,
                approvalId: input.approval.id,
                decision: 'approve',
              },
            },
          ],
        },
        {
          tag: 'button',
          text: {
            tag: 'plain_text',
            content: 'Deny',
          },
          type: 'danger',
          behaviors: [
            {
              type: 'callback',
              value: {
                kind: 'approval_decision',
                chatId: input.chatId,
                chatType: input.chatType,
                approvalId: input.approval.id,
                decision: 'reject',
              },
            },
          ],
        },
      ],
    },
  };

  return {
    preferred: { kind: 'card', payload },
    fallback: { kind: 'text', text: fallbackText },
  };
}

function buildPermissionFallback(approval: ApprovalRecord): string {
  return [
    `Approval required: ${approval.toolName ?? approval.riskSummary}`,
    approval.projectId ? `Project: ${approval.projectId}` : undefined,
    `Session: ${approval.sessionId}`,
    `Expires: ${approval.expiresAt}`,
    `Approve: /approve ${approval.id}`,
    `Reject: /reject ${approval.id}`,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

function formatToolInput(toolInput: Record<string, unknown> | undefined): string {
  const serialized = JSON.stringify(toolInput ?? {}, null, 2);
  if (serialized.length <= TOOL_INPUT_MAX_CHARS) {
    return serialized;
  }
  return `${serialized.slice(0, TOOL_INPUT_MAX_CHARS)}\n... truncated ${serialized.length - TOOL_INPUT_MAX_CHARS} chars`;
}
