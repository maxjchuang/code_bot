import type { BotConfig, ChatType } from '../domain/types.js';
import type { RenderedFeishuMessage } from './FeishuMessageRenderer.js';

export interface RenderProjectSelectorCardInput {
  chatId: string;
  chatType: ChatType;
  currentProjectId?: string;
  runningProjectId?: string;
  projects: BotConfig['projects'];
  fallbackText: string;
}

export function renderProjectSelectorCard(
  input: RenderProjectSelectorCardInput,
): { preferred: RenderedFeishuMessage; fallback: RenderedFeishuMessage } {
  const defaultProjectId = selectDefaultProjectId(input);
  const summaryLines = ['Choose the project this chat should target.'];
  if (input.currentProjectId) {
    summaryLines.push(`- **Selected**: \`${input.currentProjectId}\``);
  }
  if (input.runningProjectId) {
    summaryLines.push(`- **Running session project**: \`${input.runningProjectId}\``);
  }

  const payload = {
    schema: '2.0',
    header: {
      title: {
        tag: 'plain_text',
        content: 'Projects',
      },
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: summaryLines.join('\n'),
        },
        {
          tag: 'form',
          name: 'project_select_form',
          elements: [
            {
              tag: 'select_static',
              name: 'projectId',
              placeholder: {
                tag: 'plain_text',
                content: 'Select project',
              },
              initial_option: defaultProjectId,
              options: input.projects.map((project) => ({
                text: {
                  tag: 'plain_text',
                  content: `${project.id} (${project.name})`,
                },
                value: project.id,
              })),
            },
            {
              tag: 'button',
              name: 'confirm_project_select',
              text: {
                tag: 'plain_text',
                content: 'Use project',
              },
              type: 'primary',
              action_type: 'form_submit',
              value: {
                kind: 'project_select',
                chatId: input.chatId,
                chatType: input.chatType,
              },
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

function selectDefaultProjectId(input: RenderProjectSelectorCardInput): string | undefined {
  if (input.currentProjectId && input.projects.some((project) => project.id === input.currentProjectId)) {
    return input.currentProjectId;
  }
  if (input.runningProjectId && input.projects.some((project) => project.id === input.runningProjectId)) {
    return input.runningProjectId;
  }
  return input.projects[0]?.id;
}
