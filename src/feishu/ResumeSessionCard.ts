import type { ChatType, SessionRecord } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

const SESSION_OPTION_TEXT_LIMIT = 120;

export interface RenderResumeSessionCardInput {
  chatId: string;
  chatType: ChatType;
  projectId: string;
  sessions: SessionRecord[];
  timeZone: string;
  fallbackText: string;
}

export function renderResumeSessionCard(
  input: RenderResumeSessionCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const sessions = [...input.sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const defaultSessionId = sessions[0]?.id;
  const payload = {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: 'Resume Session',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: ['Choose a Codex session to resume.', `- **Project**: \`${input.projectId}\``].join('\n'),
        },
        {
          tag: 'form',
          name: 'resume_select_form',
          elements: [
            {
              tag: 'select_static',
              name: 'sessionId',
              placeholder: {
                tag: 'plain_text',
                content: 'Select session',
              },
              initial_option: defaultSessionId,
              options: sessions.map((session) => ({
                text: {
                  tag: 'plain_text',
                  content: formatSessionOption(session),
                },
                value: session.id,
              })),
            },
            {
              tag: 'button',
              name: 'confirm_resume_select',
              text: {
                tag: 'plain_text',
                content: 'Resume session',
              },
              type: 'primary',
              form_action_type: 'submit',
              behaviors: [
                {
                  type: 'callback',
                  value: {
                    kind: 'resume_select',
                    chatId: input.chatId,
                    chatType: input.chatType,
                  },
                },
              ],
            },
          ],
        },
      ],
    },
  };

  return {
    preferred: { kind: 'card', payload },
    fallback: { kind: 'text', text: input.fallbackText },
  };
}

function formatSessionOption(session: SessionRecord): string {
  return compactText(session.firstUserMessagePreview) || compactText(session.lastSummary) || `Session ${session.id}`;
}

function compactText(value: string | undefined): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (normalized.length <= SESSION_OPTION_TEXT_LIMIT) {
    return normalized;
  }
  return `${normalized.slice(0, SESSION_OPTION_TEXT_LIMIT - 3)}...`;
}
